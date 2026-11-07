import { config } from './config.mjs';
import { verifyStripe } from './security.mjs';

/** Log only a bounded operational category, never Stripe payloads or secrets. */
export function stripeFailureCategory(error){
  const code=String(error?.code||''),message=String(error?.message||'');
  if(code==='42P01')return 'schema_missing';
  if(code.startsWith('SQLITE_BUSY')||code==='55P03'||/Stripe webhook busy|reservation queue is full/i.test(message))return 'database_contention';
  if(error?.name==='AbortError'||error?.name==='TimeoutError')return 'stripe_api';
  if(/Stripe subscription (?:verification failed|list unavailable)|Stripe unavailable/i.test(message))return 'stripe_api';
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
async function retrieveSubscription(id,signal=AbortSignal.timeout(20000)){
  const res=await fetch('https://api.stripe.com/v1/subscriptions/'+encodeURIComponent(id),{
    headers:{Authorization:`Bearer ${config.stripe.secret}`},signal
  });
  if(!res.ok)throw new Error('Stripe subscription verification failed');
  return res.json();
}
async function listSubscriptions(customer,cursor,signal=AbortSignal.timeout(20000)){
  const query=new URLSearchParams({customer,status:'all',limit:'100'});
  if(cursor)query.set('starting_after',cursor);
  const res=await fetch('https://api.stripe.com/v1/subscriptions?'+query,{
    headers:{Authorization:`Bearer ${config.stripe.secret}`},signal
  });
  if(!res.ok)throw new Error('Stripe subscription list unavailable');
  return res.json();
}
/** Require a complete bounded customer list; a partial page cannot decide entitlement. */
async function completeSubscriptions(customer,list,signal){
  const subscriptions=[],seen=new Set();
  let cursor;
  for(let page=0;page<5;page++){
    const result=await list(customer,cursor,signal);
    if(result?.object!=='list'||!Array.isArray(result.data)||result.data.length>100||typeof result.has_more!=='boolean')
      throw new Error('Stripe subscription list is incomplete');
    for(const subscription of result.data){
      if(!/^sub_[\w]+$/.test(subscription?.id)||subscription.customer!==customer||
        !Number.isSafeInteger(subscription.created)||subscription.created<=0||
        !['active','trialing','incomplete','incomplete_expired','past_due','canceled','unpaid','paused'].includes(subscription.status)||
        !Array.isArray(subscription.items?.data)||subscription.items.has_more!==false||seen.has(subscription.id))
        throw new Error('Stripe subscription list is incomplete');
      seen.add(subscription.id);subscriptions.push(subscription);
    }
    if(!result.has_more)return subscriptions;
    if(!result.data.length)throw new Error('Stripe subscription list is incomplete');
    cursor=result.data.at(-1).id;
  }
  throw new Error('Stripe subscription list exceeded pagination bound');
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
  if(!/^price_[\w]+$/.test(price) || !Array.isArray(subscription.items?.data)||subscription.items.has_more!==false||
    subscription.items.data.some(item=>!/^price_[\w]+$/.test(item?.price?.id)))
    throw new Error('Stripe Pro price cannot be verified');
  return subscription.items.data.some(item=>item.price?.id===price)?subscription.status:'free';
}
const paid=subscription=>['active','trialing'].includes(entitlementStatus(subscription));
const terminal=subscription=>['canceled','incomplete_expired'].includes(subscription.status);
const currentKey=row=>[row?.stripe_customer_id||null,row?.stripe_subscription_id||null,row?.status||null].join('|');
/** Entitlement is the union of valid active subscriptions; this picks only the stored billing reference. */
function representative(subscriptions,currentId){
  const active=subscriptions.filter(paid);
  if(active.length){
    const existing=active.find(subscription=>subscription.id===currentId);
    if(existing)return existing;
  }
  return (active.length?active:subscriptions).sort((a,b)=>b.created-a.created||b.id.localeCompare(a.id))[0];
}
export async function processStripeEvent(db,raw,header,{retrieveSubscription:retrieve=retrieveSubscription,listSubscriptions:list=listSubscriptions}={}){
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
    const before=await db.prepare('SELECT stripe_customer_id,stripe_subscription_id,status FROM subscriptions WHERE user_id=?').get(userId);
    const pending=before?.status==='pending' && !before.stripe_subscription_id;
    const incoming=pending?verifiedSubscription(await retrieve(obj.subscription),obj.subscription,userId):null;
    if(incoming && (incoming.customer!==obj.customer || (before.stripe_customer_id && before.stripe_customer_id!==obj.customer)))
      throw new Error('Stripe Checkout customer does not match pending owner');
    return db.withSubscriptionLock(userId,async locked=>{
      if(await locked.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
      await locked.prepare(`INSERT INTO stripe_checkout_proofs(stripe_subscription_id,stripe_customer_id,user_id,session_id)
        VALUES(?,?,?,?) ON CONFLICT(stripe_subscription_id) DO NOTHING`)
        .run(obj.subscription,obj.customer,userId,obj.id);
      const proof=await locked.prepare('SELECT stripe_customer_id,user_id,session_id FROM stripe_checkout_proofs WHERE stripe_subscription_id=?').get(obj.subscription);
      if(proof?.stripe_customer_id!==obj.customer || Number(proof.user_id)!==userId || proof.session_id!==obj.id)
        throw new Error('Stripe Checkout proof conflicts with stored ownership');
      const current=await locked.prepare('SELECT stripe_customer_id,stripe_subscription_id,status FROM subscriptions WHERE user_id=?').get(userId);
      if(current?.status==='pending' && !current.stripe_subscription_id){
        if(!incoming || currentKey(current)!==currentKey(before))
          throw new Error('Stripe pending subscription changed concurrently; retry event');
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
    if(await db.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
    const stripeSignal=AbortSignal.timeout(30000);
    for(let attempt=0;attempt<3;attempt++){
      const snapshot=await db.prepare('SELECT stripe_customer_id,stripe_subscription_id,status FROM subscriptions WHERE user_id=?').get(userId);
      if(snapshot?.stripe_subscription_id && (!/^cus_[\w]+$/.test(snapshot.stripe_customer_id)||
        !/^sub_[\w]+$/.test(snapshot.stripe_subscription_id)))
        throw new Error('Stored Stripe subscription identity cannot be verified');
      const incoming=verifiedSubscription(await retrieve(obj.id,stripeSignal),obj.id,userId);
      if(obj.customer!==incoming.customer)throw new Error('Stripe customer cannot be verified');
      const customers=[...new Set([incoming.customer,snapshot?.stripe_customer_id].filter(Boolean))];
      const lists=new Map(await Promise.all(customers.map(async customer=>
        [customer,await completeSubscriptions(customer,list,stripeSignal)])));
      const listedIds=[...lists.values()].flat().map(subscription=>subscription.id);
      if(new Set(listedIds).size!==listedIds.length)throw new Error('Stripe subscription list is incomplete');
      const listed=lists.get(incoming.customer).find(subscription=>subscription.id===incoming.id);
      if(!listed||listed.status!==incoming.status||listed.created!==incoming.created||
        Number(listed.metadata?.reviewforge_user_id)!==userId||
        JSON.stringify(listed.items.data.map(item=>item.price?.id))!==JSON.stringify(incoming.items?.data?.map(item=>item.price?.id)))
        throw new Error('Stripe subscription list changed; retry event');
      try{
        return await db.withSubscriptionLock(userId,async locked=>{
          if(await locked.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
          const current=await locked.prepare('SELECT stripe_customer_id,stripe_subscription_id,status FROM subscriptions WHERE user_id=?').get(userId);
          if(currentKey(current)!==currentKey(snapshot)){
            const changed=Object.assign(new Error('Stripe subscription changed concurrently; retry event'),{retryStripeSnapshot:true});
            throw changed;
          }
          const pending=current && !current.stripe_subscription_id;
          const own=[...lists.values()].flat().filter(subscription=>Number(subscription.metadata?.reviewforge_user_id)===userId)
            .map(subscription=>verifiedSubscription(subscription,subscription.id,userId));
          const proofs=own.length?await locked.prepare(`SELECT stripe_subscription_id,stripe_customer_id,user_id FROM stripe_checkout_proofs
            WHERE stripe_subscription_id IN (${own.map(()=>'?').join(',')})`).all(...own.map(subscription=>subscription.id)):[];
          const proofById=new Map(proofs.map(proof=>[proof.stripe_subscription_id,proof]));
          for(const subscription of own){
            entitlementStatus(subscription);
            const proof=proofById.get(subscription.id);
            if(proof && (proof.stripe_customer_id!==subscription.customer || Number(proof.user_id)!==userId))
              throw new Error('Stripe subscription conflicts with Checkout owner');
          }
          const incomingProof=proofById.get(incoming.id);
          if(pending && (current.status!=='pending' || (current.stripe_customer_id && current.stripe_customer_id!==incoming.customer) || !incomingProof))
            throw new Error('Stored Stripe subscription identity cannot be verified');
          const incomingGroup=own.filter(subscription=>subscription.customer===incoming.customer);
          let selected;
          if(current?.stripe_subscription_id && current.stripe_customer_id!==incoming.customer){
            const currentGroup=own.filter(subscription=>subscription.customer===current.stripe_customer_id);
            const previous=currentGroup.find(subscription=>subscription.id===current.stripe_subscription_id);
            if(!previous)throw new Error('Stored Stripe subscription identity cannot be verified');
            if(incomingGroup.every(terminal) && currentGroup.some(subscription=>!terminal(subscription))){
              selected=representative(currentGroup,current.stripe_subscription_id);
            }else if(previous.created>incoming.created){
              if(incomingGroup.some(subscription=>!terminal(subscription)))
                throw new Error('Stripe subscription customer ownership requires manual reconciliation');
              selected=representative(currentGroup,current.stripe_subscription_id);
            }else{
              if(currentGroup.some(subscription=>!terminal(subscription)))
                throw new Error('Previous Stripe customer still has an uncanceled subscription');
              if(!incomingProof)throw new Error('Stripe customer does not match verified Checkout owner');
              selected=representative(incomingGroup,current.stripe_subscription_id);
            }
          }else{
            if(current?.stripe_subscription_id && !incomingGroup.some(subscription=>subscription.id===current.stripe_subscription_id))
              throw new Error('Stored Stripe subscription identity cannot be verified');
            selected=representative(incomingGroup,current?.stripe_subscription_id);
          }
          if(!selected)throw new Error('Stripe subscription ownership requires manual reconciliation');
          const status=entitlementStatus(selected);
          if(current){
            const changed=pending
              ?await locked.prepare(`UPDATE subscriptions SET stripe_customer_id=?,stripe_subscription_id=?,status=?,updated_at=CURRENT_TIMESTAMP
                WHERE user_id=? AND stripe_subscription_id IS NULL AND status='pending'`)
                .run(selected.customer,selected.id,status,userId)
              :await locked.prepare(`UPDATE subscriptions SET stripe_customer_id=?,stripe_subscription_id=?,status=?,updated_at=CURRENT_TIMESTAMP
                WHERE user_id=? AND stripe_subscription_id=? AND stripe_customer_id=?`)
                .run(selected.customer,selected.id,status,userId,current.stripe_subscription_id,current.stripe_customer_id);
            if(!changed.changes)throw new Error('Stripe subscription changed concurrently; retry event');
          }else{
            await locked.prepare(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status)
              VALUES(?,?,?,?)`).run(userId,selected.customer,selected.id,status);
          }
          await locked.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
          return event.type;
        });
      }catch(error){if(error.retryStripeSnapshot && attempt<2)continue;throw error;}
    }
  }
  if(await db.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
  await db.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
  return event.type;
}
