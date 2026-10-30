import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';

const sha='a'.repeat(40);
const target={
  reviewId:1,repository:'reviewer/sandbox',number:12,headSha:sha,
  installationId:42,postMode:'dry-run'
};
const makeFiles=n=>Array.from({length:n},(_,i)=>({
  filename:'src/component'+i+'.ts',status:'added',
  patch:'@@ -0,0 +1,1 @@\n+const item'+i+' = '+i+';'
}));
function fixture(count=37){
  const dir=mkdtempSync(join(tmpdir(),'rf-incremental-'));
  const db=openDatabase(join(dir,'test.sqlite'));
  db.prepare("INSERT INTO reviews(id,pr_title,head_sha) VALUES(1,'Synthetic review',?)").run(sha);
  let files=makeFiles(count),head=sha,postCount=0;
  const modelCalls=[],quotas=[];
  const deps={
    installationToken:async()=> 'fake-installation-token',
    githubApi:async(path)=>{
      assert.equal(path,'/repos/reviewer/sandbox/pulls/12');
      return {head:{sha:head},state:'open',draft:false};
    },
    changedFiles:async()=>files,
    reviewWithAI:async(batch,{batchIndex,totalBatches})=>{
      modelCalls.push({batchIndex,totalBatches});
      return {summary:'Checked batch '+batchIndex,findings:[{
        path:batch[0].filename,line:1,severity:'high',
        category:'correctness',title:'Synthetic test issue',
        body:'This is a test-only, actionable example that needs attention.',
        confidence:.91
      }]};
    },
    postReview:async()=>{postCount++;return 'inline';},
    reserveModelCalls:async count=>{quotas.push(count);return {allowed:true};},
    loadProgress:async id=>db.prepare('SELECT * FROM review_progress WHERE review_id=?').get(id),
    initProgress:async({reviewId,planHash,totalBatches})=>
      db.prepare("INSERT INTO review_progress(review_id,plan_hash,total_batches,completed_batches,results_json) VALUES(?,?,?,0,'[]') ON CONFLICT(review_id) DO NOTHING")
        .run(reviewId,planHash,totalBatches).changes===1,
    saveProgress:async({reviewId,planHash,previousBatches,completedBatches,results})=>
      db.prepare("UPDATE review_progress SET completed_batches=?,results_json=?,updated_at=CURRENT_TIMESTAMP WHERE review_id=? AND plan_hash=? AND completed_batches=?")
        .run(completedBatches,JSON.stringify(results),reviewId,planHash,previousBatches).changes===1,
  };
  return {db,deps,modelCalls,quotas,postCount:()=>postCount,
    setFiles:v=>{files=v;},setHead:v=>{head=v;},
    dispose:()=>{db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('one model batch is saved per invocation; next invocation resumes, never repeats batch 1',async()=>{
  const f=fixture();
  try{
    const first=await analyzePullRequestStep(target,f.deps);
    assert.equal(first.status,'progress');
    assert.deepEqual(first.progress,{completed_batches:1,total_batches:2});
    assert.deepEqual(f.modelCalls,[{batchIndex:1,totalBatches:2}]);
    assert.deepEqual(f.quotas,[2]);
    assert.equal(f.postCount(),0);
    const stored=f.db.prepare('SELECT * FROM review_progress WHERE review_id=1').get();
    assert.equal(stored.completed_batches,1);
    assert.match(stored.plan_hash,/^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(stored.results_json).length,1);
    assert.equal(stored.results_json.includes('const item'),false);

    const second=await analyzePullRequestStep(target,f.deps);
    assert.equal(second.status,'completed');
    assert.equal(second.posted,0);
    assert.equal(second.findings.length,2);
    assert.match(second.summary,/Preview only/);
    assert.deepEqual(f.modelCalls.map(c=>c.batchIndex),[1,2]);
    assert.deepEqual(f.quotas,[2]);
    assert.equal(f.db.prepare('SELECT completed_batches FROM review_progress WHERE review_id=1').get().completed_batches,2);
    const after=await analyzePullRequestStep(target,f.deps);
    assert.equal(after.status,'completed');
    assert.deepEqual(f.modelCalls.map(c=>c.batchIndex),[1,2]);
  }finally{f.dispose();}
});
test('changed diff or posting policy cannot mix checkpoints or publish stale findings',async()=>{
  const f=fixture();
  try{
    assert.equal((await analyzePullRequestStep(target,f.deps)).status,'progress');
    f.setFiles(makeFiles(37).map((file,i)=>i===0?
      {...file,patch:'@@ -0,0 +1,1 @@\n+differentValue();'}:file));
    const changed=await analyzePullRequestStep(target,f.deps);
    assert.equal(changed.status,'superseded');
    assert.equal(changed.posted,0);
    assert.deepEqual(f.modelCalls.map(c=>c.batchIndex),[1]);
    f.setFiles(makeFiles(37));
    const changedPolicy=await analyzePullRequestStep({...target,postMode:'live'},f.deps);
    assert.equal(changedPolicy.status,'superseded');
    assert.equal(f.postCount(),0);
  }finally{f.dispose();}
});
test('changed HEAD prevents all further model execution even when progress exists',async()=>{
  const f=fixture();
  try{
    assert.equal((await analyzePullRequestStep(target,f.deps)).status,'progress');
    f.setHead('b'.repeat(40));
    const result=await analyzePullRequestStep(target,f.deps);
    assert.equal(result.status,'superseded');
    assert.deepEqual(f.modelCalls.map(c=>c.batchIndex),[1]);
    assert.equal(f.postCount(),0);
  }finally{f.dispose();}
});
test('incomplete coverage is explicitly partial without charging a model',async()=>{
  const f=fixture(181);
  try{
    const result=await analyzePullRequestStep(target,f.deps);
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.complete,false);
    assert.match(result.summary,/no AI calls made/);
    assert.equal(f.modelCalls.length,0);
    assert.equal(f.quotas.length,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM review_progress').get().n,0);
  }finally{f.dispose();}
});
test('model failure cannot be treated as clean or implicitly retried',async()=>{
  const f=fixture();
  try{
    await analyzePullRequestStep(target,f.deps);
    f.deps.reviewWithAI=async()=>{throw new Error('Simulated paid model timeout');};
    await assert.rejects(analyzePullRequestStep(target,f.deps),error=>
      error.message==='Simulated paid model timeout' && error.nonRetryable===true);
    assert.equal(f.db.prepare('SELECT completed_batches FROM review_progress WHERE review_id=1').get().completed_batches,1);
    assert.equal(f.postCount(),0);
  }finally{f.dispose();}
});
test('checkpoint corruption fails closed before any more model calls',async()=>{
  const f=fixture();
  try{
    await analyzePullRequestStep(target,f.deps);
    f.db.prepare("UPDATE review_progress SET results_json='invalid-json' WHERE review_id=1").run();
    await assert.rejects(analyzePullRequestStep(target,f.deps),error=>
      error.nonRetryable===true && /Invalid persisted/.test(error.message));
    assert.deepEqual(f.modelCalls.map(c=>c.batchIndex),[1]);
    assert.equal(f.postCount(),0);
  }finally{f.dispose();}
});
