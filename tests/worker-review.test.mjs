import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {openDatabase} from '../src/db.mjs';
import {allowedRepositories} from '../src/review-policy.mjs';
import {requestWorkerReview,getWorkerReviewStatus,validateWorkerReviewInput,workerReviewAllowed} from '../src/worker-review.mjs';
const repo='ibboabdoli-ai/Proffera',sha='a'.repeat(40);
const policy={
 aiManualReviewRepositories:allowedRepositories(repo),
 aiShadowRepositories:allowedRepositories(repo),
 aiAllowedRepositories:allowedRepositories(repo),
 aiWorkerRequestRepositories:allowedRepositories(repo)
};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rf-worker-review-'));
 const db=openDatabase(join(dir,'db.sqlite'));
 db.prepare("INSERT INTO users(id,login,name) VALUES(7,'ibbo','Owner')").run();
 db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(42,7,'ibboabdoli-ai','active')").run();
 db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,private,enabled) VALUES(100,42,'Proffera',?,'https://github.com/ibboabdoli-ai/Proffera',0,1)").run(repo);
 let calls=0;
 const deps={policy,installationToken:async id=>{assert.equal(id,42);return 'fake-token';},
  fetchPull:async(path,token)=>{calls++;assert.equal(token,'fake-token');
   assert.equal(path,'/repos/'+repo+'/pulls/943');
   return {head:{sha,repo:{full_name:repo}},base:{ref:'main'},state:'open',draft:false,
    title:'Maria',user:{login:'ibboabdoli-ai'}};}};
 const body={repository:repo,pr_number:943,head_sha:sha};
 return {db,deps,body,calls:()=>calls,dispose:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('worker request is denied without fourth exact repository allowlist',()=>{
 assert.equal(workerReviewAllowed(repo,policy),true);
 assert.equal(workerReviewAllowed('ibboabdoli-ai/other',policy),false);
 assert.equal(workerReviewAllowed(repo,{...policy,aiWorkerRequestRepositories:[]}),false);
 assert.equal(workerReviewAllowed(repo,{...policy,aiShadowRepositories:[]}),false);
});
test('worker accepts only three exact, type-safe parameters',()=>{
 assert.deepEqual(validateWorkerReviewInput({repository:repo,pr_number:943,head_sha:sha}),{repository:repo,pr:943,head:sha});
 for(const bad of [null,{},[],{repository:repo,pr_number:943,head_sha:'bad'},
  {repository:repo,pr_number:'943evil',head_sha:sha},
  {repository:repo,pr_number:943,head_sha:sha,post_mode:'live'},
  {repository:repo,pr_number:943,head_sha:sha,installation_id:1},
  {repository:'https://other/Proffera',pr_number:943,head_sha:sha}])
  assert.throws(()=>validateWorkerReviewInput(bad),/Invalid|Only/);
});
test('worker submits exact-head request once and status exposes only manual review',async()=>{
 const f=fixture();
 try{
  const out=await requestWorkerReview(f.db,f.body,f.deps);
  assert.deepEqual(out,{id:1,headSha:sha,created:true});
  assert.equal(f.calls(),1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM manual_review_requests').get().n,1);
  const again=await requestWorkerReview(f.db,f.body,f.deps);
  assert.equal(again.id,out.id);assert.equal(again.created,false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  const status=await getWorkerReviewStatus(f.db,f.body,policy);
  assert.equal(status.id,1);assert.equal(status.status,'queued');
  assert.equal(status.posted,0);assert.equal(status.head_sha,sha);
  assert.equal(status.findings.length,0);
  assert.equal(await getWorkerReviewStatus(f.db,{...f.body,head_sha:'b'.repeat(40)},policy),null);
  f.db.prepare("UPDATE reviews SET status='completed',findings_json='[{\"path\":\"src/a.ts\",\"line\":2,\"severity\":\"high\"}]' WHERE id=1").run();
  const done=await getWorkerReviewStatus(f.db,f.body,policy);
  assert.equal(done.findings.length,1);assert.equal(done.findings[0].line,2);
 }finally{f.dispose();}
});
test('wrong head is refused before the database write',async()=>{
 const f=fixture();
 try{
  await assert.rejects(requestWorkerReview(f.db,{...f.body,head_sha:'b'.repeat(40)},f.deps),/HEAD changed/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM reviews').get().n,0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,0);
 }finally{f.dispose();}
});
test('repo ownership and active installation are resolved from DB, not worker input',async()=>{
 const f=fixture();
 try{
  f.db.prepare("UPDATE installations SET account_login='different' WHERE id=42").run();
  await assert.rejects(requestWorkerReview(f.db,f.body,f.deps),/Active owner installation/);
  assert.equal(f.calls(),0);
  await assert.rejects(requestWorkerReview(f.db,{...f.body,repository:'attacker/Proffera'},f.deps),/not approved/);
 }finally{f.dispose();}
});
test('machine API uses existing worker token, no sessions or Github posting',()=>{
 const source=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(source,/path==='\/internal\/reviews\/request'/);
 assert.match(source,/path==='\/internal\/reviews\/status'/);
 assert.match(source,/token\.length<32\|\|!safeCompare\(req\.headers\.authorization,'Bearer '\+token\)/);
 assert.match(source,/const c=await ctx\(req\)/);
 assert.ok(source.indexOf("path==='/internal/reviews/request'")<source.indexOf('const c=await ctx(req)'));
 assert.match(source,/requestWorkerReview\(db,input/);
 assert.match(source,/getWorkerReviewStatus\(db,input,config\)/);
 assert.match(source,/postMode:manual\?'dry-run'/);
});

test('expired worker lease reports stalled, never clean or successful',async()=>{
 const f=fixture();
 try{
  await requestWorkerReview(f.db,f.body,f.deps);
  f.db.prepare("UPDATE reviews SET status='running' WHERE id=1").run();
  f.db.prepare("UPDATE jobs SET status='running',next_attempt_at=? WHERE review_id=1").run(Date.now()-1000);
  const result=await getWorkerReviewStatus(f.db,f.body,policy);
  assert.equal(result.status,'stalled');
  assert.equal(result.posted,0);
  assert.match(result.error,/Timed-out worker/);
 }finally{f.dispose();}
});
test('stale PostgreSQL worker lease fails closed without paid replays',()=>{
 const source=readFileSync(new URL('../src/db-postgres.mjs',import.meta.url),'utf8');
 assert.match(source,/WITH expired AS \(/);
 assert.match(source,/UPDATE jobs SET status='failed'/);
 assert.match(source,/UPDATE reviews SET status='failed'/);
 assert.doesNotMatch(source,/UPDATE jobs SET status='queued' WHERE status='running'/);
});
