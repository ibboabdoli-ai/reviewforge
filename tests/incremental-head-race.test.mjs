import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';

test('HEAD change during changed-file retrieval must block paid reservation and model work', async()=>{
  const original='a'.repeat(40), newer='b'.repeat(40);
  let head=original, reservations=0, initializations=0, modelCalls=0, posts=0;
  const result=await analyzePullRequestStep({
    reviewId:90001,repository:'synthetic/head-race',number:17,
    headSha:original,installationId:1,postMode:'dry-run'
  },{
    installationToken:async()=> 'synthetic-token',
    githubApi:async()=>({head:{sha:head},state:'open',draft:false}),
    changedFiles:async()=>{
      // The first HEAD read was correct, but the PR changes before its diff returns.
      head=newer;
      return [{filename:'src/api/receipt.ts',status:'modified',
        patch:'@@ -1,1 +1,1 @@\\n-before();\\n+after();'}];
    },
    loadProgress:async()=>null,
    initProgress:async()=>{initializations++;return true;},
    saveProgress:async()=>true,
    reserveModelCalls:async()=>{reservations++;return {allowed:true};},
    reviewWithAI:async()=>{modelCalls++;return {summary:'Synthetic model result',findings:[]};},
    postReview:async()=>{posts++;return 'none';}
  });
  assert.equal(result.status,'superseded');
  assert.deepEqual({reservations,initializations,modelCalls,posts},
    {reservations:0,initializations:0,modelCalls:0,posts:0},
    'A PR superseded before paid review must not reserve quota or run a model');
});


test('legacy review also refuses paid work when HEAD changes while fetching files', async()=>{
  const { analyzePullRequest }=await import('../src/pipeline.mjs');
  const original='a'.repeat(40), newer='b'.repeat(40);
  let head=original, reservations=0, modelCalls=0, posts=0;
  const result=await analyzePullRequest({
    repository:'synthetic/head-race',number:17,headSha:original,
    installationId:1,postMode:'dry-run'
  },{
    installationToken:async()=> 'synthetic-token',
    githubApi:async()=>({head:{sha:head},state:'open',draft:false}),
    changedFiles:async()=>{
      head=newer;
      return [{filename:'src/api/receipt.ts',status:'modified',
        patch:'@@ -1,1 +1,1 @@\\n-before();\\n+after();'}];
    },
    reserveModelCalls:async()=>{reservations++;return {allowed:true};},
    reviewWithAI:async()=>{modelCalls++;return {summary:'Synthetic model result',findings:[]};},
    postReview:async()=>{posts++;return 'none';}
  });
  assert.equal(result.status,'superseded');
  assert.deepEqual({reservations,modelCalls,posts},
    {reservations:0,modelCalls:0,posts:0},
    'Legacy pipeline must not run paid analysis on a stale HEAD');
});

test('staged analysis must not spend a model call after HEAD changes during quota reservation', async()=>{
  const original='a'.repeat(40), newer='b'.repeat(40);
  let head=original, quota=0, checkpoints=0, model=0, posts=0;
  const result=await analyzePullRequestStep({
    reviewId:90007,repository:'synthetic/quota-race',number:17,
    headSha:original,installationId:1,postMode:'dry-run'
  },{
    installationToken:async()=> 'fake-token',
    githubApi:async()=>({head:{sha:head},state:'open',draft:false}),
    changedFiles:async()=>[{filename:'src/receipt.ts',status:'modified',
      patch:'@@ -0,0 +1,1 @@\\n+validateReceipt();'}],
    reserveModelCalls:async()=>{quota++;head=newer;return {allowed:true};},
    loadProgress:async()=>null,
    initProgress:async()=>{checkpoints++;return true;},
    saveProgress:async()=>true,
    reviewWithAI:async()=>{model++;return {summary:'Mock response',findings:[]};},
    postReview:async()=>{posts++;return 'none';}
  });
  assert.equal(result.status,'superseded');
  assert.deepEqual({quota,checkpoints,model,posts},{quota:1,checkpoints:0,model:0,posts:0});
});

test('staged analysis must not spend a model call after HEAD changes during checkpoint initialization', async()=>{
  const original='a'.repeat(40), newer='b'.repeat(40);
  let head=original, quota=0, checkpoints=0, model=0, posts=0;
  const result=await analyzePullRequestStep({
    reviewId:90008,repository:'synthetic/checkpoint-race',number:18,
    headSha:original,installationId:1,postMode:'dry-run'
  },{
    installationToken:async()=> 'fake-token',
    githubApi:async()=>({head:{sha:head},state:'open',draft:false}),
    changedFiles:async()=>[{filename:'src/receipt.ts',status:'modified',
      patch:'@@ -0,0 +1,1 @@\\n+validateReceipt();'}],
    reserveModelCalls:async()=>{quota++;return {allowed:true};},
    loadProgress:async()=>null,
    initProgress:async()=>{checkpoints++;head=newer;return true;},
    saveProgress:async()=>true,
    reviewWithAI:async()=>{model++;return {summary:'Mock response',findings:[]};},
    postReview:async()=>{posts++;return 'none';}
  });
  assert.equal(result.status,'superseded');
  assert.deepEqual({quota,checkpoints,model,posts},{quota:1,checkpoints:1,model:0,posts:0});
});

test('legacy analysis must not spend a model call after HEAD changes during quota reservation', async()=>{
  const { analyzePullRequest }=await import('../src/pipeline.mjs');
  const original='a'.repeat(40), newer='b'.repeat(40);
  let head=original, quota=0, model=0, posts=0;
  const result=await analyzePullRequest({
    repository:'synthetic/quota-race',number:19,headSha:original,
    installationId:1,postMode:'dry-run'
  },{
    installationToken:async()=> 'fake-token',
    githubApi:async()=>({head:{sha:head},state:'open',draft:false}),
    changedFiles:async()=>[{filename:'src/receipt.ts',status:'modified',
      patch:'@@ -0,0 +1,1 @@\\n+validateReceipt();'}],
    reserveModelCalls:async()=>{quota++;head=newer;return {allowed:true};},
    reviewWithAI:async()=>{model++;return {summary:'Mock response',findings:[]};},
    postReview:async()=>{posts++;return 'none';}
  });
  assert.equal(result.status,'superseded');
  assert.deepEqual({quota,model,posts},{quota:1,model:0,posts:0});
});
