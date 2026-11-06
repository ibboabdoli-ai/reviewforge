import { config } from './config.mjs';
import { verifyStripe } from './security.mjs';

/** Log only a bounded operational category, never Stripe payloads or secrets. */
export function stripeFailureCategory(error){
  const code=String(error?.code||''),message=String(error?.message||'');
  if(code==='42P01')return 'schema_missing';
  if(code.startsWith('SQLITE_BUSY')||code==='55P03'||/Stripe webhook busy|reservation queue is full/i.test(message))return 'database_contention';
  if(/Stripe subscription verification failed|Stripe unavailable/i.test(message))return 'stripe_api';
  if(/Stripe .*?(?:identity|owner|customer|proof|price|order|subscription|Checkout)|Stored Stripe/i.test(message))return 'billing_integrity';
  if(error?.status===400)return 'invalid_event';
  return 'internal_error';
}

async function stripe(path,params){
  const res=await fetch('https://api.stripe.com/v1/'+path,{
    method:'POST',headers:{Authorization:`Bearer ${config.stripe.secret}`,'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams(params),signal:AbortSignal.timeout(20000)
  });
  const data=await res.json();
  if(!res.ok)throw new Error(`Stripe: ${(data.error?.message||res.status).slice(0,180)}`);
  return data;
}
export function checkout(user){
  return stripe('checkout/sessions',{'mode':'subscription','line_items[0][price]':config.stripe.pricePro,
    'line_items[0][quantity]':'1','client_reference_id':String(user.id),
    ...(user.email?{'customer_email':user.email}:{}),
    'success_url':config.baseUrl+'/billing?checkout=complete',
    'cancel_url':config.baseUrl+'/billing?checkout=canceled',
    'subscription_data[metadata][reviewforge_user_id]':String(user.id)});
}
/** Reserve the billing owner before creating any payable Stripe session. */
export async function startCheckout(db,user,{create=checkout}={}){
  const reserved=await db.prepare("INSERT OR IGNORE INTO subscriptions(user_id,status) VALUES(?,'pending')").run(user.id);
  if(reserved.changes!==1)
    throw Object.assign(new Error('Billing is already pending or subscribed; resolve the existing session first.'),{status:409});
  // A failed response may still mean Stripe created the session. Keep the
  // reservation until a verified webhook or manual reconciliation resolves it.
  return create(user);
}
export function portal(customerId){return stripe('billing_portal/sessions',{customer:customerId,return_url:config.baseUrl+'/billing'});}
async function retrieveSubscription(id){
  const res=await fetch('https://api.stripe.com/v1/subscriptions/'+encodeURIComponent(id),{
    headers:{Authorization:`Bearer ${config.stripe.secret}`},signal:AbortSignal.timeout(20000)
  });
  if(!res.ok)throw new Error('Stripe subscription verification failed');
  return res.json();
}
function verifiedSubscription(value,id,userId){
  if(!value || value.id!==id || !/^sub_[\w]+$/.test(id) ||
     !/^cus_[\w]+$/.test(value.customer) ||
     Number(value.metadata?.reviewforge_user_id)!==userId ||
     !Number.isSafeInteger(value.created) || value.created<=0 ||
     !['active','trialing','incomplete','incomplete_expired','past_due','canceled','unpaid','paused'].includes(value.status))
    throw new Error('Stripe subscription identity cannot be verified');
  return value;
}
function entitlementStatus(subscription){
  const price=config.stripe.pricePro;
  if(!/^price_[\w]+$/.test(price) || !Array.isArray(subscription.items?.data))
    throw new Error('Stripe Pro price cannot be verified');
  return subscription.items.data.some(item=>item.price?.id===price)?subscription.status:'free';
}
export async function processStripeEvent(db,raw,header,{retrieveSubscription:retrieve=retrieveSubscription}={}){
  if(!verifyStripe(raw,header,config.stripe.webhookSecret))throw Object.assign(new Error('Invalid Stripe signature'),{status:400});
  let event;
  try{event=JSON.parse(raw);}catch{throw Object.assign(new Error('Invalid Stripe event JSON'),{status:400});}
  const obj=event.data?.object||{};
  if(typeof event.id!=='string'||!event.id.startsWith('evt_'))throw Object.assign(new Error('Stripe event has no ID'),{status:400});
  // A signed Checkout completion records identity proof, never entitlement.
  if(event.type==='checkout.session.completed' && obj.mode==='subscription'){
    const userId=Number(obj.client_reference_id);
    if(!Number.isSafeInteger(userId)||userId<=0 || !/^cs_[\w]+$/.test(obj.id) ||
       !/^sub_[\w]+$/.test(obj.subscription) || !/^cus_[\w]+$/.test(obj.customer))
      throw new Error('Stripe Checkout identity cannot be verified');
    return db.withSubscriptionLock(userId,async locked=>{
      if(await locked.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
      await locked.prepare(`INSERT INTO stripe_checkout_proofs(stripe_subscription_id,stripe_customer_id,user_id,session_id)
        VALUES(?,?,?,?) ON CONFLICT(stripe_subscription_id) DO NOTHING`)
        .run(obj.subscription,obj.customer,userId,obj.id);
      const proof=await locked.prepare('SELECT stripe_customer_id,user_id,session_id FROM stripe_checkout_proofs WHERE stripe_subscription_id=?').get(obj.subscription);
      if(proof?.stripe_customer_id!==obj.customer || Number(proof.user_id)!==userId || proof.session_id!==obj.id)
        throw new Error('Stripe Checkout proof conflicts with stored ownership');
      const pending=await locked.prepare('SELECT stripe_customer_id,stripe_subscription_id,status FROM subscriptions WHERE user_id=?').get(userId);
      if(pending?.status==='pending' && !pending.stripe_subscription_id){
        const incoming=verifiedSubscription(await retrieve(obj.subscription),obj.subscription,userId);
        if(incoming.customer!==obj.customer || (pending.stripe_customer_id && pending.stripe_customer_id!==obj.customer))
          throw new Error('Stripe Checkout customer does not match pending owner');
        const changed=await locked.prepare(`UPDATE subscriptions SET stripe_customer_id=?,stripe_subscription_id=?,status=?,updated_at=CURRENT_TIMESTAMP
          WHERE user_id=? AND stripe_subscription_id IS NULL AND status='pending'`)
          .run(incoming.customer,incoming.id,entitlementStatus(incoming),userId);
        if(!changed.changes)throw new Error('Stripe pending subscription changed concurrently; retry event');
      }
      await locked.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
      return event.type;
    });
  }
  if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
    const userId=Number(obj.metadata?.reviewforge_user_id);
    if(!Number.isSafeInteger(userId)||userId<=0)throw new Error('Stripe subscription owner cannot be verified');
    if(typeof obj.id!=='string'||!/^sub_[\w]+$/.test(obj.id))throw new Error('Stripe subscription identity cannot be verified');
    return db.withSubscriptionLock(userId,async locked=>{
      if(await locked.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
      const incoming=verifiedSubscription(await retrieve(obj.id),obj.id,userId);
      if(obj.customer!==incoming.customer)throw new Error('Stripe customer cannot be verified');
      const incomingStatus=entitlementStatus(incoming);
      const proof=await locked.prepare('SELECT stripe_customer_id,user_id FROM stripe_checkout_proofs WHERE stripe_subscription_id=?').get(incoming.id);
      if(proof && (proof.stripe_customer_id!==incoming.customer || Number(proof.user_id)!==userId))
        throw new Error('Stripe subscription conflicts with Checkout owner');
      const current=await locked.prepare('SELECT stripe_customer_id,stripe_subscription_id,status FROM subscriptions WHERE user_id=?').get(userId);
      const pending=current && !current.stripe_subscription_id;
      if(current && !pending && (!/^cus_[\w]+$/.test(current.stripe_customer_id)||!/^sub_[\w]+$/.test(current.stripe_subscription_id)))
        throw new Error('Stored Stripe subscription identity cannot be verified');
      if(pending && (current.status!=='pending' || (current.stripe_customer_id && current.stripe_customer_id!==incoming.customer) ||
        !proof || proof.stripe_customer_id!==incoming.customer || Number(proof.user_id)!==userId))
        throw new Error('Stored Stripe subscription identity cannot be verified');
      let previous;
      if(current?.stripe_subscription_id && current.stripe_subscription_id!==incoming.id){
        previous=verifiedSubscription(await retrieve(current.stripe_subscription_id),current.stripe_subscription_id,userId);
        if(previous.customer!==current.stripe_customer_id)throw new Error('Stripe customer does not match previous subscription');
        const previousStatus=entitlementStatus(previous);
        if(previous.created>=incoming.created){
          if(previous.created===incoming.created && !(
            ['canceled','incomplete_expired'].includes(previous.status) &&
            ['active','trialing'].includes(incomingStatus) && proof))
            throw new Error('Stripe subscription order cannot be verified');
          if(previous.created>incoming.created){
            const changed=await locked.prepare(`UPDATE subscriptions SET status=?,updated_at=CURRENT_TIMESTAMP
              WHERE user_id=? AND stripe_subscription_id=? AND stripe_customer_id=?`)
              .run(previousStatus,userId,current.stripe_subscription_id,current.stripe_customer_id);
            if(!changed.changes)throw new Error('Stripe subscription changed concurrently; retry event');
            await locked.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
            return event.type;
          }
        }
        if(['active','trialing'].includes(previousStatus) && !['active','trialing'].includes(incomingStatus)){
          const changed=await locked.prepare(`UPDATE subscriptions SET status=?,updated_at=CURRENT_TIMESTAMP
            WHERE user_id=? AND stripe_subscription_id=? AND stripe_customer_id=?`)
            .run(previousStatus,userId,current.stripe_subscription_id,current.stripe_customer_id);
          if(!changed.changes)throw new Error('Stripe subscription changed concurrently; retry event');
          await locked.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
          return event.type;
        }
      }
      if(current && !pending && current.stripe_customer_id!==incoming.customer){
        if(!['canceled','incomplete_expired'].includes(previous?.status))throw new Error('Previous Stripe customer still has an uncanceled subscription');
        if(proof?.stripe_customer_id!==incoming.customer || Number(proof.user_id)!==userId)
          throw new Error('Stripe customer does not match verified Checkout owner');
      }
      if(current){
        const changed=pending
          ?await locked.prepare(`UPDATE subscriptions SET stripe_customer_id=?,stripe_subscription_id=?,status=?,updated_at=CURRENT_TIMESTAMP
            WHERE user_id=? AND stripe_subscription_id IS NULL AND status='pending'`)
            .run(incoming.customer,incoming.id,incomingStatus,userId)
          :await locked.prepare(`UPDATE subscriptions SET stripe_customer_id=?,stripe_subscription_id=?,status=?,updated_at=CURRENT_TIMESTAMP
            WHERE user_id=? AND stripe_subscription_id=? AND stripe_customer_id=?`)
            .run(incoming.customer,incoming.id,incomingStatus,userId,current.stripe_subscription_id,current.stripe_customer_id);
        if(!changed.changes)throw new Error('Stripe subscription changed concurrently; retry event');
      }else{
        await locked.prepare(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status)
          VALUES(?,?,?,?)`).run(userId,incoming.customer,incoming.id,incomingStatus);
      }
      await locked.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
      return event.type;
    });
  }
  if(await db.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
  await db.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
  return event.type;
}
