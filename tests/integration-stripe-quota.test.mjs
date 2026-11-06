import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {config} from '../src/config.mjs';
import {openDatabase,activePlan} from '../src/db.mjs';
import {processStripeEvent} from '../src/stripe.mjs';

test('combined SQLite Stripe and monthly reservations remain responsive',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-combined-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  const old=config.stripe.webhookSecret;config.stripe.webhookSecret='whsec_combined';
  try{
    db.prepare("INSERT INTO users(id,login,name) VALUES(1,'owner','Owner')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login) VALUES(10,1,'example')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url) VALUES(20,10,'repo','example/repo','https://github.com/example/repo')").run();
    const raw=JSON.stringify({id:'evt_combined',type:'customer.subscription.created',data:{object:{id:'sub_combined',customer:'cus_combined',metadata:{reviewforge_user_id:'1'}}}});
    const t=Math.floor(Date.now()/1000),signature=`t=${t},v1=${createHmac('sha256',config.stripe.webhookSecret).update(`${t}.${raw}`).digest('hex')}`;
    let started,release;
    const entered=new Promise(resolve=>{started=resolve;});
    const hold=new Promise(resolve=>{release=resolve;});
    const stripe=processStripeEvent(db,raw,signature,{retrieveSubscription:async()=>{
      started();await hold;return {id:'sub_combined',customer:'cus_combined',created:100,status:'active',metadata:{reviewforge_user_id:'1'}};
    }});
    await entered;
    let reserved;
    try{reserved=await db.reserveReview({installationId:10,repositoryId:20,prNumber:1,title:'PR',author:'owner',headSha:'a'.repeat(40)});}
    finally{release();}
    await assert.rejects(stripe,/locked|snapshot/i);
    assert.equal(reserved.created,true);
    assert.equal(db.prepare("SELECT id FROM stripe_events WHERE id='evt_combined'").get(),undefined);
    await processStripeEvent(db,raw,signature,{retrieveSubscription:async()=>({id:'sub_combined',customer:'cus_combined',created:100,status:'active',metadata:{reviewforge_user_id:'1'}})});
    assert.equal(await activePlan(db,1),'pro');
    assert.equal(db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  }finally{config.stripe.webhookSecret=old;db.close();rmSync(dir,{recursive:true,force:true});}
});
