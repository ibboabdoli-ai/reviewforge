import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {openDatabase,activePlan} from '../src/db.mjs';
import {processStripeEvent,stripeFailureCategory} from '../src/stripe.mjs';
import {withStripePoolSlot,withOwnerReservationSlot} from '../src/db-postgres.mjs';

const secret='whsec_ordering_test';
function sign(event){
  const raw=JSON.stringify(event);
  const t=Math.floor(Date.now()/1000);
  return [raw,`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex')}`];
}
function signed(id,type,subscription='sub_old'){
  return sign({id,type,data:{object:{id:subscription,customer:'cus_one',status:type.endsWith('deleted')?'canceled':'active',metadata:{reviewforge_user_id:'1'}}}});
}
function checkout(id,subscription,customer){
  return sign({id,type:'checkout.session.completed',data:{object:{id:'cs_'+id,mode:'subscription',client_reference_id:'1',subscription,customer}}});
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rf-stripe-order-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  db.prepare("INSERT INTO users(id,login,name) VALUES(1,'alice','Alice')").run();
  const old=[config.stripe.webhookSecret,config.stripe.pricePro];
  config.stripe.webhookSecret=secret;config.stripe.pricePro='price_pro_test';
  const items={data:[{price:{id:'price_pro_test'}}]};
  const objects=new Map([
    ['sub_old',{id:'sub_old',customer:'cus_one',created:100,status:'canceled',metadata:{reviewforge_user_id:'1'},items}],
    ['sub_new',{id:'sub_new',customer:'cus_one',created:200,status:'active',metadata:{reviewforge_user_id:'1'},items}]
  ]);
  const retrieveSubscription=async id=>objects.get(id);
  const send=(id,type,sub)=>processStripeEvent(db,...signed(id,type,sub),{retrieveSubscription});
  return {db,path:join(dir,'db.sqlite'),objects,send,dispose(){[config.stripe.webhookSecret,config.stripe.pricePro]=old;db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('a subscription at another price cannot grant Pro',async()=>{
  const f=fixture();try{
    f.objects.set('sub_new',{...f.objects.get('sub_new'),items:{data:[{price:{id:'price_other'}}]}});
    await f.send('evt_wrong_price','customer.subscription.created','sub_new');
    assert.equal(await activePlan(f.db,1),'free');
    assert.equal(f.db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'free');
  }finally{f.dispose();}
});
test('an older event revokes Pro when the stored subscription changed to another price',async()=>{
  const f=fixture();try{
    await f.send('evt_current_price','customer.subscription.created','sub_new');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),items:{data:[{price:{id:'price_other'}}]}});
    await f.send('evt_old_price_check','customer.subscription.deleted','sub_old');
    assert.equal(await activePlan(f.db,1),'free');
  }finally{f.dispose();}
});
test('Checkout completion repairs a proven pending billing row',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,status) VALUES(1,'cus_one','pending')").run();
    await processStripeEvent(f.db,...checkout('evt_pending_proof','sub_new','cus_one'),{retrieveSubscription:async id=>f.objects.get(id)});
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE user_id=1').get().stripe_subscription_id,'sub_new');
  }finally{f.dispose();}
});
test('Checkout proof repairs a pending row before a customer ID was recorded',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO subscriptions(user_id,status) VALUES(1,'pending')").run();
    await processStripeEvent(f.db,...checkout('evt_empty_pending','sub_new','cus_one'),{retrieveSubscription:async id=>f.objects.get(id)});
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});
test('a Checkout proof cannot be assigned to a different metadata owner',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO users(id,login) VALUES(2,'other')").run();
    await processStripeEvent(f.db,...checkout('evt_proof','sub_new','cus_one'));
    f.objects.set('sub_new',{...f.objects.get('sub_new'),metadata:{reviewforge_user_id:'2'}});
    const foreign=sign({id:'evt_foreign_owner',type:'customer.subscription.created',data:{object:{id:'sub_new',customer:'cus_one',metadata:{reviewforge_user_id:'2'}}}});
    await assert.rejects(processStripeEvent(f.db,...foreign,{retrieveSubscription:async id=>f.objects.get(id)}),/Checkout|owner|proof/i);
    assert.equal(await activePlan(f.db,2),'free');
  }finally{f.dispose();}
});
test('a canceled predecessor can be replaced at the same creation second with Checkout proof',async()=>{
  const f=fixture();try{
    await f.send('evt_first','customer.subscription.created','sub_old');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),created:100});
    await processStripeEvent(f.db,...checkout('evt_tie_proof','sub_new','cus_one'));
    await f.send('evt_tie_replacement','customer.subscription.created','sub_new');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE user_id=1').get().stripe_subscription_id,'sub_new');
  }finally{f.dispose();}
});
test('incomplete expired predecessor can be replaced under a new proven customer',async()=>{
  const f=fixture();try{
    f.objects.set('sub_old',{...f.objects.get('sub_old'),status:'incomplete_expired'});
    await f.send('evt_first','customer.subscription.created','sub_old');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),customer:'cus_two'});
    await processStripeEvent(f.db,...checkout('evt_expired_proof','sub_new','cus_two'));
    const event=sign({id:'evt_expired_replacement',type:'customer.subscription.created',data:{object:{id:'sub_new',customer:'cus_two',metadata:{reviewforge_user_id:'1'}}}});
    await processStripeEvent(f.db,...event,{retrieveSubscription:async id=>f.objects.get(id)});
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});
test('newer inactive subscription cannot downgrade an active Pro entitlement',async()=>{
  const f=fixture();try{
    f.objects.set('sub_old',{...f.objects.get('sub_old'),status:'active'});
    await f.send('evt_active','customer.subscription.created','sub_old');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),status:'incomplete'});
    await f.send('evt_incomplete_new','customer.subscription.created','sub_new');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE user_id=1').get().stripe_subscription_id,'sub_old');
  }finally{f.dispose();}
});
test('old subscription deletion cannot replace a newer active subscription',async()=>{
  const f=fixture();try{
    await f.send('evt_new','customer.subscription.created','sub_new');
    await f.send('evt_old','customer.subscription.deleted','sub_old');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE user_id=1').get().stripe_subscription_id,'sub_new');
  }finally{f.dispose();}
});
test('newer subscription replaces an old one, and later old events stay ignored',async()=>{
  const f=fixture();try{
    f.objects.set('sub_old',{...f.objects.get('sub_old'),status:'active'});
    await f.send('evt_old_start','customer.subscription.created','sub_old');
    assert.equal(await activePlan(f.db,1),'pro');
    f.objects.set('sub_old',{...f.objects.get('sub_old'),status:'canceled'});
    await f.send('evt_replace','customer.subscription.created','sub_new');
    await f.send('evt_old_late','customer.subscription.deleted','sub_old');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE user_id=1').get().stripe_subscription_id,'sub_new');
  }finally{f.dispose();}
});
test('delayed same-subscription update uses current Stripe state and duplicate is idempotent',async()=>{
  const f=fixture();try{
    await f.send('evt_first','customer.subscription.created','sub_new');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),status:'canceled'});
    await f.send('evt_cancel','customer.subscription.deleted','sub_new');
    assert.equal(await activePlan(f.db,1),'free');
    assert.equal(await f.send('evt_first','customer.subscription.created','sub_new'),'duplicate');
    await f.send('evt_delayed','customer.subscription.updated','sub_new');
    assert.equal(await activePlan(f.db,1),'free');
  }finally{f.dispose();}
});
test('checkout cannot overwrite an established subscription; unverifiable events fail closed',async()=>{
  const f=fixture();try{
    await f.send('evt_new','customer.subscription.created','sub_new');
    const [raw,signature]=signed('evt_checkout','checkout.session.completed','sub_old');
    await processStripeEvent(f.db,raw,signature,{retrieveSubscription:async()=>{throw Error('must not retrieve checkout')}});
    assert.equal(await activePlan(f.db,1),'pro');
    await assert.rejects(f.send('evt_unknown','customer.subscription.updated','sub_unknown'),/verify|Stripe/i);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_unknown'").get(),undefined);
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});
test('same subscription can renew; older or mismatched customer cannot change owner',async()=>{
  const f=fixture();try{
    await f.send('evt_new','customer.subscription.created','sub_new');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),status:'canceled'});
    await f.send('evt_cancel','customer.subscription.deleted','sub_new');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),status:'active'});
    await f.send('evt_renew','customer.subscription.updated','sub_new');
    assert.equal(await activePlan(f.db,1),'pro');
    f.objects.set('sub_old',{...f.objects.get('sub_old'),created:300,status:'active',customer:'cus_other'});
    await assert.rejects(f.send('evt_wrong','customer.subscription.updated','sub_old'),/customer|verify/i);
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});
test('concurrent webhooks for one owner serialize current-state reads and writes',async()=>{
  const f=fixture();try{
    let started,release;
    const firstStarted=new Promise(resolve=>{started=resolve;});
    const firstRelease=new Promise(resolve=>{release=resolve;});
    let calls=0;
    const retrieveSubscription=async id=>{
      const snapshot={...f.objects.get(id)};
      if(++calls===1){started();await firstRelease;}
      return snapshot;
    };
    const first=processStripeEvent(f.db,...signed('evt_one','customer.subscription.created','sub_new'),{retrieveSubscription});
    await firstStarted;
    const second=processStripeEvent(f.db,...signed('evt_two','customer.subscription.deleted','sub_new'),{retrieveSubscription});
    f.objects.set('sub_new',{...f.objects.get('sub_new'),status:'canceled'});
    release();
    await Promise.all([first,second]);
    assert.equal(await activePlan(f.db,1),'free');
    assert.equal(calls,2);
  }finally{f.dispose();}
});
test('separate SQLite connections process webhooks without blocking the event loop',async()=>{
  const f=fixture(),second=openDatabase(f.path);try{
    let started,release;
    const entered=new Promise(resolve=>{started=resolve;});
    const hold=new Promise(resolve=>{release=resolve;});
    const first=processStripeEvent(f.db,...signed('evt_conn_one','customer.subscription.created','sub_new'),{
      retrieveSubscription:async()=>{started();await hold;return {...f.objects.get('sub_new'),status:'active'};}
    });
    await entered;
    const next=processStripeEvent(second,...signed('evt_conn_two','customer.subscription.deleted','sub_new'),{
      retrieveSubscription:async()=>({...f.objects.get('sub_new'),status:'canceled'})
    });
    const timerStarted=Date.now();
    await new Promise(resolve=>setTimeout(resolve,75));
    assert.ok(Date.now()-timerStarted<1000,'another webhook must not block the event loop');
    release();
    await Promise.all([first,next]);
    assert.equal(await activePlan(f.db,1),'free');
  }finally{second.close();f.dispose();}
});
test('unrelated SQLite writes proceed during Stripe fetch; stale snapshots retry safely',async()=>{
  const f=fixture(),other=openDatabase(f.path);try{
    let started,release;
    const entered=new Promise(resolve=>{started=resolve;});
    const hold=new Promise(resolve=>{release=resolve;});
    const event=signed('evt_snapshot','customer.subscription.created','sub_new');
    const pending=processStripeEvent(f.db,...event,{retrieveSubscription:async()=>{
      started();await hold;return f.objects.get('sub_new');
    }});
    await entered;
    const at=Date.now();
    other.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES('other',1,9999999999999)").run();
    assert.ok(Date.now()-at<1000,'unrelated write should not wait for Stripe');
    release();
    await assert.rejects(pending,/locked|snapshot/i);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_snapshot'").get(),undefined);
    await processStripeEvent(f.db,...event,{retrieveSubscription:async()=>f.objects.get('sub_new')});
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{other.close();f.dispose();}
});
test('unverifiable replacement order or Stripe outage leaves state and event unmodified',async()=>{
  const f=fixture();try{
    await f.send('evt_new','customer.subscription.created','sub_new');
    f.objects.set('sub_old',{...f.objects.get('sub_old'),created:200,status:'active'});
    await assert.rejects(f.send('evt_tie','customer.subscription.updated','sub_old'),/order cannot be verified/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_tie'").get(),undefined);
    await assert.rejects(processStripeEvent(f.db,...signed('evt_api','customer.subscription.updated','sub_new'),
      {retrieveSubscription:async()=>{throw Error('Stripe unavailable');}}),/unavailable/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_api'").get(),undefined);
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});
test('incomplete stored billing identity cannot consume a subscription event',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,status) VALUES(1,'cus_one','pending')").run();
    await assert.rejects(f.send('evt_incomplete','customer.subscription.created','sub_new'),/Stored Stripe subscription identity/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_incomplete'").get(),undefined);
    assert.equal(await activePlan(f.db,1),'free');
  }finally{f.dispose();}
});
test('a verified later Checkout can replace a canceled subscription with a new customer',async()=>{
  const f=fixture();try{
    await f.send('evt_old','customer.subscription.created','sub_old');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),customer:'cus_two'});
    await processStripeEvent(f.db,...checkout('evt_checkout_new','sub_new','cus_two'));
    const event=sign({id:'evt_new_customer',type:'customer.subscription.created',data:{object:{id:'sub_new',customer:'cus_two',metadata:{reviewforge_user_id:'1'}}}});
    await processStripeEvent(f.db,...event,{retrieveSubscription:async id=>f.objects.get(id)});
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id=1').get().stripe_customer_id,'cus_two');
    await f.send('evt_old_after_customer_change','customer.subscription.deleted','sub_old');
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});
test('a subscription event arriving before Checkout proof is retried after proof arrives',async()=>{
  const f=fixture();try{
    await f.send('evt_old','customer.subscription.created','sub_old');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),customer:'cus_two'});
    const event=sign({id:'evt_early',type:'customer.subscription.created',data:{object:{id:'sub_new',customer:'cus_two',metadata:{reviewforge_user_id:'1'}}}});
    const options={retrieveSubscription:async id=>f.objects.get(id)};
    await assert.rejects(processStripeEvent(f.db,...event,options),/customer/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_early'").get(),undefined);
    await processStripeEvent(f.db,...checkout('evt_checkout_late','sub_new','cus_two'));
    await processStripeEvent(f.db,...event,options);
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});
test('a Checkout proof for another user cannot rebind an existing billing owner',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO users(id,login,name) VALUES(2,'other','Other')").run();
    await f.send('evt_old','customer.subscription.created','sub_old');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),customer:'cus_two'});
    const [raw]=checkout('evt_foreign','sub_new','cus_two');
    const checkoutEvent=JSON.parse(raw);checkoutEvent.data.object.client_reference_id='2';
    const foreign=sign(checkoutEvent);
    await processStripeEvent(f.db,...foreign);
    const event=sign({id:'evt_foreign_sub',type:'customer.subscription.created',data:{object:{id:'sub_new',customer:'cus_two',metadata:{reviewforge_user_id:'1'}}}});
    await assert.rejects(processStripeEvent(f.db,...event,{retrieveSubscription:async id=>f.objects.get(id)}),/Checkout owner/);
    assert.equal(f.db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id=1').get().stripe_customer_id,'cus_one');
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_foreign_sub'").get(),undefined);
  }finally{f.dispose();}
});
test('a second customer cannot hide an uncanceled subscription from the billing portal',async()=>{
  const f=fixture();try{
    f.objects.set('sub_old',{...f.objects.get('sub_old'),status:'active'});
    await f.send('evt_old','customer.subscription.created','sub_old');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),customer:'cus_two'});
    await processStripeEvent(f.db,...checkout('evt_checkout_new','sub_new','cus_two'));
    const event=sign({id:'evt_new_customer',type:'customer.subscription.created',data:{object:{id:'sub_new',customer:'cus_two',metadata:{reviewforge_user_id:'1'}}}});
    await assert.rejects(processStripeEvent(f.db,...event,{retrieveSubscription:async id=>f.objects.get(id)}),/uncanceled/);
    assert.equal(f.db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id=1').get().stripe_customer_id,'cus_one');
  }finally{f.dispose();}
});
test('an older event reconciles the current subscription status from Stripe',async()=>{
  const f=fixture();try{
    await f.send('evt_current','customer.subscription.created','sub_new');
    f.objects.set('sub_new',{...f.objects.get('sub_new'),status:'canceled'});
    await f.send('evt_old_late','customer.subscription.deleted','sub_old');
    assert.equal(await activePlan(f.db,1),'free');
  }finally{f.dispose();}
});
test('PostgreSQL webhook gate reserves pool capacity for other requests',async()=>{
  let started,release;
  const entered=new Promise(resolve=>{started=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const first=withStripePoolSlot(async()=>{started();await hold;return 'first';});
  await entered;
  await assert.rejects(withStripePoolSlot(async()=> 'second'),/busy/);
  release();
  assert.equal(await first,'first');
  assert.equal(await withStripePoolSlot(async()=> 'third'),'third');
});
test('quota reservations for one billing owner wait outside the PostgreSQL pool',async()=>{
  let entered,release,secondEntered=false;
  const started=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const first=withOwnerReservationSlot(1,async()=>{entered();await hold;return 'first';});
  await started;
  const second=withOwnerReservationSlot(1,async()=>{secondEntered=true;return 'second';});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(secondEntered,false);
  release();
  assert.deepEqual(await Promise.all([first,second]),['first','second']);
});
test('malformed webhook JSON is a client error; upstream parse failures remain retryable',async()=>{
  const f=fixture();try{
    const raw='{bad',t=Math.floor(Date.now()/1000);
    const signature=`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex')}`;
    await assert.rejects(processStripeEvent(f.db,raw,signature),error=>error.status===400);
    await assert.rejects(processStripeEvent(f.db,...signed('evt_upstream','customer.subscription.created','sub_new'),
      {retrieveSubscription:async()=>{throw new SyntaxError('upstream JSON');}}),error=>error.status!==400);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_upstream'").get(),undefined);
  }finally{f.dispose();}
});
test('Stripe failure categories distinguish retryable locks from integrity failures without raw data',()=>{
  assert.equal(stripeFailureCategory(Object.assign(new Error('secret data'),{code:'SQLITE_BUSY_SNAPSHOT'})),'database_contention');
  assert.equal(stripeFailureCategory(Object.assign(new Error('secret data'),{code:'42P01'})),'schema_missing');
  assert.equal(stripeFailureCategory(new Error('Stripe subscription conflicts with Checkout owner')),'billing_integrity');
  assert.equal(stripeFailureCategory(new Error('secret data')),'internal_error');
});
