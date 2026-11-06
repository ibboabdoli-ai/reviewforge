import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Worker} from 'node:worker_threads';
import {openDatabase} from '../src/db.mjs';
import {enqueueManualReview} from '../src/manual-review.mjs';

const repo='example/private',sha='a'.repeat(40);
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rf-monthly-quota-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  db.prepare("INSERT INTO users(id,login,name) VALUES(1,'owner','Owner')").run();
  db.prepare("INSERT INTO installations(id,owner_user_id,account_login) VALUES(10,1,'example')").run();
  db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url) VALUES(20,10,'private',?,'https://github.com/example/private')").run(repo);
  const policy={aiManualReviewRepositories:[repo],aiShadowRepositories:[repo],aiAllowedRepositories:[repo],aiUnlimitedRepositories:[]};
  const input={userId:1,repoFullName:repo,prNumber:'100',policy,
    installationToken:async()=> 'test-token',fetchPull:async()=>({state:'open',base:{ref:'main'},head:{sha,repo:{full_name:repo}},title:'Test',user:{login:'owner'}})};
  const used=n=>{for(let i=1;i<=n;i++)db.prepare("INSERT INTO reviews(installation_id,repository_id,pr_number,pr_title,head_sha) VALUES(10,20,?,'Previous',?)").run(i,'b'.repeat(39)+(i%10));};
  return {db,path:join(dir,'db.sqlite'),input,used,dispose(){db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('manual request cannot create a job after free owner exhausts monthly quota',async()=>{
  const f=fixture();try{
    f.used(10);
    await assert.rejects(enqueueManualReview(f.db,f.input),/monthly review limit/i);
    assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM reviews').get().n,10);
  }finally{f.dispose();}
});
test('duplicate manual request at the limit reuses its marker and job',async()=>{
  const f=fixture();try{
    f.used(9);
    const first=await enqueueManualReview(f.db,f.input);
    const again=await enqueueManualReview(f.db,f.input);
    assert.equal(first.created,true);assert.equal(again.created,false);
    assert.equal(first.id,again.id);
    assert.equal(f.db.prepare('SELECT count(*) n FROM reviews').get().n,10);
    assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  }finally{f.dispose();}
});
test('two concurrent SQLite connections cannot both take the final slot',async()=>{
  const f=fixture();try{
    f.used(9);
    const gate=new SharedArrayBuffer(4),view=new Int32Array(gate);
    const workers=[101,102].map(n=>new Worker(new URL('./quota-worker.mjs',import.meta.url),{workerData:{path:f.path,gate,prNumber:n,headSha:String(n).padStart(40,'c')}}));
    const signals=workers.map(worker=>{
      let ready;
      const arrived=new Promise((resolve,reject)=>{
        ready=resolve;worker.once('error',reject);
      });
      const result=new Promise((resolve,reject)=>{
        worker.on('message',m=>m==='ready'?ready():resolve(m));
        worker.once('error',reject);
      });
      return {arrived,result};
    });
    await Promise.all(signals.map(s=>s.arrived));
    // Workers are blocked on the shared gate until both have opened the database.
    Atomics.store(view,0,1);Atomics.notify(view,0,2);
    const results=await Promise.all(signals.map(s=>s.result));
    assert.deepEqual(results.sort(),['created','limited']);
    assert.equal(f.db.prepare('SELECT count(*) n FROM reviews').get().n,10);
    assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
    await Promise.all(workers.map(w=>w.terminate()));
  }finally{f.dispose();}
});
test('pro limit and exact shadow exception apply to billing owner',async()=>{
  const f=fixture();try{
    f.used(10);
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_test','sub_test','active')").run();
    const created=await enqueueManualReview(f.db,f.input);
    assert.equal(created.created,true);
    f.db.prepare("UPDATE subscriptions SET status='canceled' WHERE user_id=1").run();
    const other={...f.input,prNumber:'103',policy:{...f.input.policy,aiUnlimitedRepositories:[repo]}};
    const exempt=await enqueueManualReview(f.db,other);
    assert.equal(exempt.created,true);
    await assert.rejects(enqueueManualReview(f.db,{...other,prNumber:'104',policy:{...other.policy,aiShadowRepositories:[]}}),/not enabled/);
  }finally{f.dispose();}
});
test('automatic reservations share the same owner limit across installations',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO installations(id,owner_user_id,account_login) VALUES(11,1,'second')").run();
    f.db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url) VALUES(21,11,'other','second/other','https://github.com/second/other')").run();
    f.used(9);
    const options={installationId:11,repositoryId:21,prNumber:5,title:'Auto',author:'owner',headSha:'e'.repeat(40)};
    assert.equal((await f.db.reserveReview(options)).created,true);
    assert.equal((await f.db.reserveReview(options)).created,false);
    await assert.rejects(f.db.reserveReview({...options,prNumber:6,headSha:'f'.repeat(40)}),/Monthly review limit/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  }finally{f.dispose();}
});
test('SQLite reservation waits without blocking another writer from completing',async()=>{
  const f=fixture(),writer=openDatabase(f.path);try{
    writer.exec('BEGIN IMMEDIATE');
    const pending=f.db.reserveReview({installationId:10,repositoryId:20,prNumber:110,
      title:'After writer',author:'owner',headSha:'d'.repeat(40)});
    await new Promise(resolve=>setTimeout(resolve,75));
    writer.exec('COMMIT');
    assert.equal((await pending).created,true);
    assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  }finally{writer.close();f.dispose();}
});
