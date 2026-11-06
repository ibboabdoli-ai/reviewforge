import { config } from './config.mjs';
import { verifyStripe } from './security.mjs';

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
export async function processStripeEvent(db,raw,header,{retrieveSubscription:retrieve=retrieveSubscription}={}){
  if(!verifyStripe(raw,header,config.stripe.webhookSecret))throw new Error('Invalid Stripe signature');
  const event=JSON.parse(raw);const obj=event.data?.object||{};
  if(typeof event.id!=='string'||!event.id.startsWith('evt_'))throw new Error('Stripe event has no ID');
  // Checkout completion is only a signal: subscription webhooks establish entitlement.
  if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
    const userId=Number(obj.metadata?.reviewforge_user_id);
    if(!Number.isSafeInteger(userId)||userId<=0)throw new Error('Stripe subscription owner cannot be verified');
    if(typeof obj.id!=='string'||!/^sub_[\w]+$/.test(obj.id))throw new Error('Stripe subscription identity cannot be verified');
    return db.withSubscriptionLock(userId,async locked=>{
      if(await locked.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
      const incoming=verifiedSubscription(await retrieve(obj.id),obj.id,userId);
      if(obj.customer!==incoming.customer)throw new Error('Stripe customer cannot be verified');
      const current=await locked.prepare('SELECT stripe_customer_id,stripe_subscription_id FROM subscriptions WHERE user_id=?').get(userId);
      if(current && (!/^cus_[\w]+$/.test(current.stripe_customer_id)||!/^sub_[\w]+$/.test(current.stripe_subscription_id)))
        throw new Error('Stored Stripe subscription identity cannot be verified');
      if(current && current.stripe_customer_id!==incoming.customer)
        throw new Error('Stripe customer does not match billing owner');
      if(current?.stripe_subscription_id && current.stripe_subscription_id!==incoming.id){
        const previous=verifiedSubscription(await retrieve(current.stripe_subscription_id),current.stripe_subscription_id,userId);
        if(previous.customer!==incoming.customer)throw new Error('Stripe customer does not match previous subscription');
        if(previous.created>=incoming.created){
          if(previous.created===incoming.created)throw new Error('Stripe subscription order cannot be verified');
          await locked.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
          return event.type;
        }
      }
      if(current){
        const changed=await locked.prepare(`UPDATE subscriptions SET stripe_customer_id=?,stripe_subscription_id=?,status=?,updated_at=CURRENT_TIMESTAMP
          WHERE user_id=? AND stripe_subscription_id=? AND stripe_customer_id=?`)
          .run(incoming.customer,incoming.id,incoming.status,userId,current.stripe_subscription_id,current.stripe_customer_id);
        if(!changed.changes)throw new Error('Stripe subscription changed concurrently; retry event');
      }else{
        await locked.prepare(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status)
          VALUES(?,?,?,?)`).run(userId,incoming.customer,incoming.id,incoming.status);
      }
      await locked.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
      return event.type;
    });
  }
  if(await db.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
  await db.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
  return event.type;
}
