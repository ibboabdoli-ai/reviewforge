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
export async function processStripeEvent(db,raw,header){
  if(!verifyStripe(raw,header,config.stripe.webhookSecret))throw new Error('Invalid Stripe signature');
  const event=JSON.parse(raw);const obj=event.data?.object||{};
  if(typeof event.id!=='string'||!event.id.startsWith('evt_'))throw new Error('Stripe event has no ID');
  if(await db.prepare('SELECT id FROM stripe_events WHERE id=?').get(event.id))return 'duplicate';
  if(event.type==='checkout.session.completed' && obj.mode==='subscription'){
    const userId=Number(obj.client_reference_id);
    if(Number.isSafeInteger(userId)&&userId>0){
      await db.prepare(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(?,?,?,'pending')
        ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=excluded.stripe_customer_id,stripe_subscription_id=excluded.stripe_subscription_id,updated_at=CURRENT_TIMESTAMP`).run(userId,String(obj.customer),String(obj.subscription));
    }
  }
  if(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted'].includes(event.type)){
    const userId=Number(obj.metadata?.reviewforge_user_id);
    if(Number.isSafeInteger(userId)&&userId>0){
      const current=event.type==='customer.subscription.deleted'?'canceled':String(obj.status||'incomplete');
      await db.prepare(`INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET stripe_customer_id=excluded.stripe_customer_id,
        stripe_subscription_id=excluded.stripe_subscription_id,status=excluded.status,updated_at=CURRENT_TIMESTAMP`).run(userId,String(obj.customer),String(obj.id),current);
    }
  }
  await db.prepare('INSERT INTO stripe_events(id) VALUES(?)').run(event.id);
  return event.type;
}
