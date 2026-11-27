import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {openDatabase,activePlan,allowedReviews} from '../src/db.mjs';
import {processStripeEvent} from '../src/stripe.mjs';

const secret='whsec_multi_test';
const pro='price_pro_test';
function signed(id,subscription){
  const raw=JSON.stringify({id,type:'customer.subscription.updated',data:{object:{
    id:subscription.id,customer:subscription.customer,metadata:subscription.metadata
  }}});
  const t=Math.floor(Date.now()/1000);
  return [raw,`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex')}`];
}
function sub(id,created,status='active',{customer='cus_one',user='1',price=pro}={}){
  return {id,customer,created,status,metadata:{reviewforge_user_id:user},
    items:{data:[{price:{id:price}}],has_more:false}};
}
function fixture(subscriptions){
  const dir=mkdtempSync(join(tmpdir(),'rf-stripe-multi-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  db.prepare("INSERT INTO users(id,login) VALUES(1,'owner'),(2,'other')").run();
  const previous=[config.stripe.webhookSecret,config.stripe.pricePro];
  config.stripe.webhookSecret=secret;config.stripe.pricePro=pro;
  const objects=new Map(subscriptions.map(item=>[item.id,item]));
  const options={
    retrieveSubscription:async id=>objects.get(id),
    listSubscriptions:async(customer,cursor)=>{
      const all=[...objects.values()].filter(item=>item.customer===customer);
      const start=cursor?all.findIndex(item=>item.id===cursor)+1:0;
      return {object:'list',data:all.slice(start,start+100),has_more:start+100<all.length};
    }
  };
  const send=(id,subscriptionId)=>processStripeEvent(db,...signed(id,objects.get(subscriptionId)),options);
  return {db,objects,options,send,dispose(){[config.stripe.webhookSecret,config.stripe.pricePro]=previous;db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('three active subscriptions retain Pro when the stored representative cancels',async()=>{
  const f=fixture([sub('sub_a',100),sub('sub_b',200),sub('sub_c',300)]);
  try{
    await f.send('evt_a','sub_a');await f.send('evt_b','sub_b');await f.send('evt_c','sub_c');
    f.objects.set('sub_c',{...f.objects.get('sub_c'),status:'canceled'});
    await f.send('evt_canceled','sub_c');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal((await allowedReviews(f.db,1)).limit,500);
    f.db.prepare("INSERT INTO installations(id,owner_user_id,account_login) VALUES(10,1,'org')").run();
    f.db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url) VALUES(20,10,'repo','org/repo','https://example.invalid/repo')").run();
    for(let number=1;number<=11;number++){
      const result=await f.db.reserveReview({installationId:10,repositoryId:20,prNumber:number,
        title:'PR',author:'owner',headSha:String(number).padStart(40,'0')});
      assert.equal(result.created,true,'the valid Pro owner retains the 500-review quota');
    }
  }finally{f.dispose();}
});

test('four mixed subscriptions retain the only verified active Pro subscription',async()=>{
  const f=fixture([sub('sub_a',100,'active'),sub('sub_b',200,'incomplete'),
    sub('sub_c',300,'canceled'),sub('sub_d',400,'active',{price:'price_other'})]);
  try{
    await f.send('evt_a','sub_a');await f.send('evt_b','sub_b');
    await f.send('evt_c','sub_c');await f.send('evt_d','sub_d');
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});

test('a newer inactive subscription cannot displace either of two older active Pro subscriptions',async()=>{
  const f=fixture([sub('sub_a',100),sub('sub_b',200),sub('sub_c',300,'incomplete')]);
  try{
    await f.send('evt_active','sub_b');await f.send('evt_inactive','sub_c');
    assert.equal(await activePlan(f.db,1),'pro');
    f.objects.set('sub_b',{...f.objects.get('sub_b'),status:'canceled'});
    await f.send('evt_b_canceled','sub_b');
    assert.equal(f.db.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE user_id=1').get().stripe_subscription_id,'sub_a');
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{f.dispose();}
});

test('foreign metadata and wrong prices never create an owner Pro entitlement',async()=>{
  const f=fixture([sub('sub_foreign',100,'active',{user:'2'}),sub('sub_wrong',200,'active',{price:'price_other'}),
    sub('sub_inactive',300,'canceled')]);
  try{
    await f.send('evt_wrong','sub_wrong');await f.send('evt_inactive','sub_inactive');
    assert.equal(await activePlan(f.db,1),'free');
    assert.equal((await allowedReviews(f.db,1)).limit,10);
    f.db.prepare("INSERT INTO stripe_checkout_proofs(stripe_subscription_id,stripe_customer_id,user_id,session_id) VALUES('sub_wrong','cus_one',2,'cs_foreign')").run();
    await assert.rejects(f.send('evt_conflict','sub_wrong'),/Checkout owner/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_conflict'").get(),undefined);
  }finally{f.dispose();}
});

test('active subscriptions under two customers require manual reconciliation',async()=>{
  const f=fixture([sub('sub_old',100,'active',{customer:'cus_old'}),
    sub('sub_new',200,'active',{customer:'cus_new'})]);
  try{
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_new','sub_new','active')").run();
    await assert.rejects(f.send('evt_old_customer','sub_old'),/manual reconciliation/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_old_customer'").get(),undefined);
    assert.equal(f.db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id=1').get().stripe_customer_id,'cus_new');
  }finally{f.dispose();}
});

test('a tied stale canceled customer event cannot displace the current active customer',async()=>{
  const f=fixture([sub('sub_old',100,'canceled',{customer:'cus_old'}),
    sub('sub_new',100,'active',{customer:'cus_new'})]);
  try{
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_new','sub_new','active')").run();
    await f.send('evt_old_tie','sub_old');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id=1').get().stripe_customer_id,'cus_new');
  }finally{f.dispose();}
});

test('equal timestamps and reversed webhook order keep every active subscription eligible',async()=>{
  const f=fixture([sub('sub_a',100),sub('sub_b',100),sub('sub_c',100)]);
  try{
    await f.send('evt_b','sub_b');await f.send('evt_a','sub_a');await f.send('evt_c','sub_c');
    assert.equal(await activePlan(f.db,1),'pro');
    f.objects.set('sub_b',{...f.objects.get('sub_b'),status:'canceled'});
    await f.send('evt_b_canceled','sub_b');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(await f.send('evt_b_canceled','sub_b'),'duplicate');
  }finally{f.dispose();}
});

test('a complete second Stripe page can supply the only active Pro subscription',async()=>{
  const inactive=Array.from({length:100},(_,index)=>sub('sub_'+String(index).padStart(3,'0'),index+1,'canceled'));
  const f=fixture([...inactive,sub('sub_last',101)]);
  try{
    await f.send('evt_page','sub_000');
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(f.db.prepare('SELECT stripe_subscription_id FROM subscriptions WHERE user_id=1').get().stripe_subscription_id,'sub_last');
  }finally{f.dispose();}
});

test('the Stripe list request uses customer, all statuses, and a validated pagination cursor',async()=>{
  const inactive=Array.from({length:100},(_,index)=>sub('sub_'+String(index).padStart(3,'0'),index+1,'canceled'));
  const active=sub('sub_last',101);
  const f=fixture([...inactive,active]);
  const oldFetch=globalThis.fetch;
  const cursors=[];
  try{
    globalThis.fetch=async url=>{
      const request=new URL(url);
      assert.equal(request.pathname,'/v1/subscriptions');
      assert.equal(request.searchParams.get('customer'),'cus_one');
      assert.equal(request.searchParams.get('status'),'all');
      assert.equal(request.searchParams.get('limit'),'100');
      cursors.push(request.searchParams.get('starting_after'));
      return {ok:true,json:async()=>cursors.length===1
        ?{object:'list',data:inactive,has_more:true}
        :{object:'list',data:[active],has_more:false}};
    };
    await processStripeEvent(f.db,...signed('evt_http_page',inactive[0]),{retrieveSubscription:async id=>f.objects.get(id)});
    assert.deepEqual(cursors,[null,'sub_099']);
    assert.equal(await activePlan(f.db,1),'pro');
  }finally{globalThis.fetch=oldFetch;f.dispose();}
});

test('incomplete Stripe pages and API failures never consume an event or change entitlement',async()=>{
  const f=fixture([sub('sub_a',100)]);
  try{
    await f.send('evt_first','sub_a');
    f.objects.set('sub_a',{...f.objects.get('sub_a'),status:'canceled'});
    const event=signed('evt_failure',f.objects.get('sub_a'));
    await assert.rejects(processStripeEvent(f.db,...event,{...f.options,
      listSubscriptions:async()=>{throw new Error('Stripe unavailable');}}),/unavailable/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_failure'").get(),undefined);
    await assert.rejects(processStripeEvent(f.db,...event,{...f.options,
      listSubscriptions:async()=>({object:'list',data:[],has_more:true})}),/incomplete/);
    await assert.rejects(processStripeEvent(f.db,...event,{...f.options,
      listSubscriptions:async()=>({object:'list',data:[{...f.objects.get('sub_a'),items:{data:[],has_more:true}}],has_more:false})}),/incomplete/);
    await assert.rejects(processStripeEvent(f.db,...event,{...f.options,
      listSubscriptions:async()=>({object:'list',data:[{...f.objects.get('sub_a'),items:{data:[]}}],has_more:false})}),/incomplete/);
    const invalid={...f.objects.get('sub_a'),items:{data:[{price:{}}],has_more:false}};
    await assert.rejects(processStripeEvent(f.db,...event,{...f.options,retrieveSubscription:async()=>invalid,
      listSubscriptions:async()=>({object:'list',data:[invalid],has_more:false})}),/price/);
    assert.equal(await activePlan(f.db,1),'pro');
    await f.send('evt_recovered','sub_a');
    assert.equal(await activePlan(f.db,1),'free');
  }finally{f.dispose();}
});

test('five full Stripe pages still reporting more fail closed',async()=>{
  const f=fixture([sub('sub_a',100)]);
  try{
    const event=signed('evt_too_many',f.objects.get('sub_a'));
    let page=0;
    await assert.rejects(processStripeEvent(f.db,...event,{...f.options,
      listSubscriptions:async()=>({object:'list',data:Array.from({length:100},(_,index)=>
        sub('sub_page_'+page+'_'+index,100+page*100+index)),has_more:++page<=5})}),/pagination bound/);
    assert.equal(f.db.prepare("SELECT id FROM stripe_events WHERE id='evt_too_many'").get(),undefined);
  }finally{f.dispose();}
});

test('cancelling every verified Pro subscription eventually restores the Free quota',async()=>{
  const f=fixture([sub('sub_a',100),sub('sub_b',200),sub('sub_c',300)]);
  try{
    await f.send('evt_active','sub_c');
    for(const id of ['sub_c','sub_b','sub_a']){
      f.objects.set(id,{...f.objects.get(id),status:'canceled'});
      await f.send('evt_cancel_'+id,id);
    }
    assert.equal(await activePlan(f.db,1),'free');
    assert.equal((await allowedReviews(f.db,1)).limit,10);
  }finally{f.dispose();}
});

test('concurrent events retry a changed local snapshot and remain idempotent',async()=>{
  const f=fixture([sub('sub_a',100),sub('sub_b',200),sub('sub_c',300)]);
  try{
    const results=await Promise.all([f.send('evt_parallel_a','sub_a'),f.send('evt_parallel_b','sub_b')]);
    assert.deepEqual(results,['customer.subscription.updated','customer.subscription.updated']);
    assert.equal(await activePlan(f.db,1),'pro');
    assert.equal(await f.send('evt_parallel_a','sub_a'),'duplicate');
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM stripe_events WHERE id LIKE 'evt_parallel_%'").get().n,2);
  }finally{f.dispose();}
});
