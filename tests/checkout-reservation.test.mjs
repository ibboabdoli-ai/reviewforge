import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {startCheckout} from '../src/stripe.mjs';

test('concurrent Checkout requests can create only one payable session',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    let entered,release,calls=0;
    const started=new Promise(resolve=>{entered=resolve;});
    const hold=new Promise(resolve=>{release=resolve;});
    const create=async()=>{calls++;entered();await hold;return {url:'https://checkout.stripe.test/session'};};
    const first=startCheckout(db,{id:1},{create});
    await started;
    await assert.rejects(startCheckout(db,{id:1},{create}),error=>error.status===409);
    release();
    assert.equal((await first).url,'https://checkout.stripe.test/session');
    assert.equal(calls,1);
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('an uncertain Stripe response keeps the Checkout reservation closed',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-checkout-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,login) VALUES(1,'owner')").run();
    await assert.rejects(startCheckout(db,{id:1},{create:async()=>{throw new Error('Stripe response lost');}}),/response lost/);
    await assert.rejects(startCheckout(db,{id:1},{create:async()=>({url:'https://checkout.stripe.test/second'})}),
      error=>error.status===409);
    assert.equal(db.prepare('SELECT status FROM subscriptions WHERE user_id=1').get().status,'pending');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
