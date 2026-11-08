import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {startCheckout} from '../src/stripe.mjs';
import {processStripeEvent} from '../src/stripe.mjs';
import {createHmac} from 'node:crypto';
import {config} from '../src/config.mjs';
import {DatabaseSync} from 'node:sqlite';

function signed(event,secret){
  const raw=JSON.stringify(event),t=Math.floor(Date.now()/1000);
  return [raw,`t=${t},v1=${createHmac('sha256',secret).update(`${t}.${raw}`).digest('hex')}`];
}

test('concurrent Checkout requests can create only one payable session',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    let entered,release,calls=0;
    const started=new Promise(resolve=>{entered=resolve;});
    const hold=new Promise(resolve=>{release=resolve;});
    const create=async()=>{calls++;entered();await hold;return {id:'cs_first',url:'https://checkout.stripe.test/session'};};
    const first=startCheckout(db,{id:1},{create});
    await started;
    await assert.rejects(startCheckout(db,{id:1},{create}),error=>error.status===409);
    release();
    assert.equal((await first).url,'https://checkout.stripe.test/session');
    assert.equal(calls,1);
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
    assert.equal(db.prepare('SELECT checkout_session_id FROM subscriptions WHERE user_id=1').get().checkout_session_id,'cs_first');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('an uncertain Stripe response keeps the Checkout reservation closed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    await assert.rejects(startCheckout(db,{id:1},{create:async()=>{throw new Error('Stripe response lost');}}),/response lost/);
    await assert.rejects(startCheckout(db,{id:1},{create:async()=>({id:'cs_second',url:'https://checkout.stripe.test/second'})}),
      error=>error.status===409);
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('a canceled subscription can reserve a new Checkout without duplicate sessions',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-')),db=openDatabase(join(dir,'db.sqlite'));
  const previous=config.stripe.pricePro;config.stripe.pricePro='price_pro_test';
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_old','sub_old','canceled')").run();
    const old={id:'sub_old',customer:'cus_old',created:100,status:'canceled',metadata:{reviewforge_user_id:'1'},items:{data:[{price:{id:'price_pro_test'}}],has_more:false}};
    let calls=0;
    const options={retrieveSubscription:async()=>old,listSubscriptions:async()=>({object:'list',data:[old],has_more:false}),
      create:async()=>{calls++;return {id:'cs_new',url:'https://checkout.stripe.test/new'};}};
    assert.equal((await startCheckout(db,{id:1},options)).id,'cs_new');
    await assert.rejects(startCheckout(db,{id:1},options),error=>error.status===409);
    assert.equal(calls,1);
    const row=db.prepare('SELECT status,stripe_subscription_id FROM subscriptions WHERE user_id=1').get();
    assert.equal(row.status,'pending');assert.equal(row.stripe_subscription_id,'sub_old');
  }finally{config.stripe.pricePro=previous;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('only the matching expired Checkout releases its pending reservation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-')),db=openDatabase(join(dir,'db.sqlite'));
  const previous=config.stripe.webhookSecret;config.stripe.webhookSecret='whsec_checkout_test';
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    await startCheckout(db,{id:1},{create:async()=>({id:'cs_first',url:'https://checkout.stripe.test/first'})});
    const expire=(id,session)=>processStripeEvent(db,...signed({id,type:'checkout.session.expired',
      data:{object:{id:session,mode:'subscription',client_reference_id:'1'}}},config.stripe.webhookSecret));
    await expire('evt_wrong','cs_wrong');
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
    await expire('evt_first','cs_first');
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get(),undefined);
    await startCheckout(db,{id:1},{create:async()=>({id:'cs_second',url:'https://checkout.stripe.test/second'})});
    await expire('evt_late','cs_first');
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
  }finally{config.stripe.webhookSecret=previous;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('a definite Stripe client error releases a reservation; uncertain failures do not',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-')),db=openDatabase(join(dir,'db.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    await assert.rejects(startCheckout(db,{id:1},{create:async()=>{throw Object.assign(new Error('invalid price'),{stripeStatus:400});}}),/invalid price/);
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get(),undefined);
    await assert.rejects(startCheckout(db,{id:1},{create:async()=>{throw Object.assign(new Error('rate limited'),{stripeStatus:429});}}),/rate limited/);
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('expired replacement restores the terminal predecessor, while completed replacement grants Pro',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-')),db=openDatabase(join(dir,'db.sqlite'));
  const oldConfig=[config.stripe.webhookSecret,config.stripe.pricePro];
  config.stripe.webhookSecret='whsec_checkout_test';config.stripe.pricePro='price_pro_test';
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_old','sub_old','canceled')").run();
    const item=id=>({id,customer:'cus_old',created:id==='sub_old'?100:200,
      status:id==='sub_old'?'canceled':'active',metadata:{reviewforge_user_id:'1'},
      items:{data:[{price:{id:'price_pro_test'}}],has_more:false}});
    const objects=new Map([['sub_old',item('sub_old')]]);
    let sessions=0;
    const options={create:async()=>({id:++sessions===1?'cs_replace':'cs_second',url:'https://checkout.stripe.test/replace'}),
      retrieveSubscription:async id=>objects.get(id),
      listSubscriptions:async()=>({object:'list',data:[...objects.values()],has_more:false})};
    const event=(id,type,object)=>processStripeEvent(db,...signed({id,type,data:{object}},config.stripe.webhookSecret),options);
    await startCheckout(db,{id:1},options);
    await event('evt_old','customer.subscription.deleted',{id:'sub_old',customer:'cus_old',metadata:{reviewforge_user_id:'1'}});
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
    await event('evt_expired','checkout.session.expired',{id:'cs_replace',mode:'subscription',client_reference_id:'1'});
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'canceled');
    await startCheckout(db,{id:1},options);
    objects.set('sub_new',item('sub_new'));
    await event('evt_complete','checkout.session.completed',{id:'cs_second',mode:'subscription',client_reference_id:'1',
      subscription:'sub_new',customer:'cus_old'});
    await event('evt_new','customer.subscription.created',{id:'sub_new',customer:'cus_old',metadata:{reviewforge_user_id:'1'}});
    const row=db.prepare('SELECT status,stripe_subscription_id,checkout_session_id FROM subscriptions WHERE user_id=1').get();
    assert.equal(row.status,'active');assert.equal(row.stripe_subscription_id,'sub_new');assert.equal(row.checkout_session_id,null);
  }finally{[config.stripe.webhookSecret,config.stripe.pricePro]=oldConfig;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('a stored Free row cannot create a payable session while its Stripe subscription is live',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-')),db=openDatabase(join(dir,'db.sqlite'));
  const previous=config.stripe.pricePro;config.stripe.pricePro='price_pro_test';
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_old','sub_old','free')").run();
    const live={id:'sub_old',customer:'cus_old',created:100,status:'active',metadata:{reviewforge_user_id:'1'},
      items:{data:[{price:{id:'price_other'}}],has_more:false}};
    let created=0;
    await assert.rejects(startCheckout(db,{id:1},{listSubscriptions:async()=>({object:'list',data:[live],has_more:false}),
      create:async()=>{created++;return {id:'cs_unsafe',url:'https://checkout.stripe.test/unsafe'};}}),error=>error.status===409);
    assert.equal(created,0);
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'free');
  }finally{config.stripe.pricePro=previous;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('a shared Stripe customer with another live owner requires manual reconciliation before Checkout',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-')),db=openDatabase(join(dir,'db.sqlite'));
  const previous=config.stripe.pricePro;config.stripe.pricePro='price_pro_test';
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_old','sub_old','canceled')").run();
    const item=(id,status,user)=>({id,customer:'cus_old',created:100,status,metadata:{reviewforge_user_id:user},
      items:{data:[{price:{id:'price_pro_test'}}],has_more:false}});
    let created=0;
    await assert.rejects(startCheckout(db,{id:1},{listSubscriptions:async()=>({object:'list',
      data:[item('sub_old','canceled','1'),item('sub_other','active','2')],has_more:false}),
      create:async()=>{created++;return {id:'cs_unsafe',url:'https://checkout.stripe.test/unsafe'};}}),/manual reconciliation/);
    assert.equal(created,0);
  }finally{config.stripe.pricePro=previous;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('opening an existing SQLite database adds Checkout reservation columns',()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-')),path=join(dir,'db.sqlite');
  const legacy=new DatabaseSync(path);
  legacy.exec('CREATE TABLE subscriptions (user_id INTEGER PRIMARY KEY, stripe_customer_id TEXT UNIQUE, stripe_subscription_id TEXT UNIQUE, status TEXT NOT NULL DEFAULT \'free\', updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
  legacy.close();
  const db=openDatabase(path);
  try{
    const columns=db.prepare('PRAGMA table_info(subscriptions)').all().map(row=>row.name);
    assert.ok(columns.includes('checkout_session_id'));
    assert.ok(columns.includes('checkout_previous_status'));
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
