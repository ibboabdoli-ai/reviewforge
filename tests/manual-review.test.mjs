import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFileSync} from 'node:fs';
import {openDatabase} from '../src/db.mjs';
import {enqueueManualReview,manualReviewAllowed,validPrNumber} from '../src/manual-review.mjs';
import {analyzePullRequest} from '../src/pipeline.mjs';
import {allowedRepositories} from '../src/review-policy.mjs';

const repo='ibboabdoli-ai/Proffera';
const sha='a'.repeat(40),other='b'.repeat(40);
const policy={
 aiManualReviewRepositories:allowedRepositories(repo),
 aiShadowRepositories:allowedRepositories(repo),
 aiAllowedRepositories:allowedRepositories(repo)
};
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'rf-manual-'));
 const db=openDatabase(join(dir,'data.sqlite'));
 db.prepare("INSERT INTO users(id,login,name) VALUES(1,'ibbo','Owner')").run();
 db.prepare("INSERT INTO users(id,login,name) VALUES(2,'outsider','Outsider')").run();
 db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(42,1,'ibbo','active')").run();
 db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,private,enabled) VALUES(100,42,'Proffera',?,'https://github.com/ibboabdoli-ai/Proffera',0,1)").run(repo);
 let called=0;
 const input={userId:1,repoFullName:repo,prNumber:'943',policy,
  installationToken:async id=>{assert.equal(id,42);return 'test-installation-token';},
  fetchPull:async(path,token)=>{called++;assert.equal(path,'/repos/'+repo+'/pulls/943');assert.equal(token,'test-installation-token');return {
   state:'open',draft:true,base:{ref:'main'},head:{sha,repo:{full_name:repo}},title:'Maria preview',user:{login:'ibbo'}
  }}
 };
 return {db,input,getCalls:()=>called,dispose:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}
test('manual shadow is deny-by-default and bounded to exact approved repo',()=>{
 assert.equal(manualReviewAllowed(repo,policy),true);
 assert.equal(manualReviewAllowed('ibboabdoli-ai/other',policy),false);
 assert.equal(manualReviewAllowed(repo,{...policy,aiShadowRepositories:[]}),false);
 assert.equal(validPrNumber('943'),943);
 for(const invalid of ['0','-1','1abc','','100000000','1.5'])assert.equal(validPrNumber(invalid),null);
});
test('manual request persists a no-post marker BEFORE one job and is idempotent',async()=>{
 const f=fixture();
 try{
  const created=await enqueueManualReview(f.db,f.input);
  assert.deepEqual(created,{id:1,headSha:sha,created:true});
  assert.ok(f.db.prepare('SELECT review_id FROM manual_review_requests WHERE review_id=?').get(created.id));
  const row=f.db.prepare('SELECT status,head_sha FROM reviews WHERE id=?').get(created.id);
  assert.equal(row.status,'queued');assert.equal(row.head_sha,sha);
  assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
  const again=await enqueueManualReview(f.db,f.input);
  assert.equal(again.created,false);assert.equal(again.id,created.id);
  assert.equal(f.db.prepare('SELECT count(*) n FROM jobs').get().n,1);
 }finally{f.dispose();}
});
test('different user cannot review installed repo even if repo and PR guessed',async()=>{
 const f=fixture();
 try{
  await assert.rejects(enqueueManualReview(f.db,{...f.input,userId:2}),/not accessible/);
  assert.equal(f.getCalls(),0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM reviews').get().n,0);
 }finally{f.dispose();}
});
test('manual request refuses closed, forked and wrong-base PRs',async()=>{
 const f=fixture();
 try{
  for(const changes of [{state:'closed'},{base:{ref:'release'}},{head:{sha,repo:{full_name:'attacker/fork'}}}]){
   const x={...f.input,fetchPull:async()=>({
    state:'open',base:{ref:'main'},head:{sha,repo:{full_name:repo}},...changes
   })};
   await assert.rejects(enqueueManualReview(f.db,x),/PR must be open/);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM reviews').get().n,0);
 }finally{f.dispose();}
});
test('an existing automatic review cannot be converted to a manual one',async()=>{
 const f=fixture();
 try{
  f.db.prepare("INSERT INTO reviews(installation_id,repository_id,pr_number,pr_title,head_sha,status) VALUES(42,100,943,'Maria',?,'completed')").run(sha);
  await assert.rejects(enqueueManualReview(f.db,f.input),/already has an automated review/);
 }finally{f.dispose();}
});
test('draft PR can run with manual dry-run and cannot post any review',async()=>{
 let posts=0;const target={repository:repo,number:943,headSha:sha,installationId:42,postMode:'dry-run',allowDraft:true};
 const dependencies={
  githubApi:async()=>({state:'open',draft:true,head:{sha}}),
  installationToken:async()=> 'test',
  changedFiles:async()=>[{filename:'src/example.ts',status:'modified',patch:'@@ -0,0 +1,1 @@\n+const enabled = true;'}],
  reviewWithAI:async()=>({summary:'No issues found in changed lines.',findings:[]}),
  postReview:async()=>{posts++;return 'inline';}
 };
 const result=await analyzePullRequest(target,dependencies);
 assert.equal(result.status,'completed');assert.equal(result.posted,0);assert.equal(posts,0);
 await assert.rejects(analyzePullRequest({...target,postMode:'fallback'},dependencies),/must never publish/);
});
test('worker always forces marker-backed reviews into dry-run mode even if fallback enabled',()=>{
 const source=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(source,/SELECT review_id FROM manual_review_requests WHERE review_id=\?/);
 assert.match(source,/postMode:manual\?'dry-run':effectiveReviewPostMode/);
 assert.match(source,/allowDraft:!!manual/);
 assert.match(source,/enqueueManualReview\(db,/);
 assert.match(source,/formPost\(req,c\)/);
});


test('authenticated manual handler wakes only an owned, already-queued, non-posted review',()=>{
 const source=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(source,/created\.created\?null:await db\.prepare\(/);
 assert.match(source,/JOIN manual_review_requests m ON m\.review_id=r\.id/);
 assert.match(source,/JOIN installations i ON i\.id=r\.installation_id WHERE r\.id=\? AND i\.owner_user_id=\?/);
 assert.match(source,/prior\?\.job_status==='queued'/);
 assert.match(source,/prior\?\.review_status==='queued'/);
 assert.match(source,/Number\(prior\.posted\)===0/);
 assert.match(source,/Number\(prior\.next_attempt_at\)<=Date\.now\(\)/);
 assert.match(source,/processQueue\(Number\(created\.id\)\)/);
 assert.match(source,/if\(\(created\.created \|\| queued\) && process\.env\.VERCEL\)/);
 assert.match(source,/postMode:manual\?'dry-run'/);
});
