import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {openDatabase,activePlan} from '../src/db.mjs';
import {processStripeEvent} from '../src/stripe.mjs';

const secret='whsec_ordering_test';
function signed(id,type,subscription='sub_old'){
  const raw=JSON.stringify({id,type,data:{object:{id:subscription,customer:'cus_one',status:type.endsWith('deleted')?'canceled':'active',metadata:{reviewforge_user_id:'1'}}}});
  const t=Math.floor(Date.now()/1000);
  return [raw,`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex')}`];
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rf-stripe-order-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  db.prepare("INSERT INTO users(id,login,name) VALUES(1,'alice','Alice')").run();
  const old=config.stripe.webhookSecret;config.stripe.webhookSecret=secret;
  const objects=new Map([
    ['sub_old',{id:'sub_old',customer:'cus_one',created:100,status:'canceled',metadata:{reviewforge_user_id:'1'}}],
    ['sub_new',{id:'sub_new',customer:'cus_one',created:200,status:'active',metadata:{reviewforge_user_id:'1'}}]
  ]);
  const retrieveSubscription=async id=>objects.get(id);
  const send=(id,type,sub)=>processStripeEvent(db,...signed(id,type,sub),{retrieveSubscription});
  return {db,path:join(dir,'db.sqlite'),objects,send,dispose(){config.stripe.webhookSecret=old;db.close();rmSync(dir,{recursive:true,force:true});}};
}
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
    f.objects.set('sub_old',{...f.objects.get('sub_old'),status:'active',customer:'cus_other'});
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
    await new Promise(resolve=>setTimeout(resolve,75));
    release();
    await Promise.all([first,next]);
    assert.equal(await activePlan(f.db,1),'free');
  }finally{second.close();f.dispose();}
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
