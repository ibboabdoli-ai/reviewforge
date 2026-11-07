import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFilesForReview,planReviewBatches} from '../src/reviewer.mjs';
import {analyzePullRequest} from '../src/pipeline.mjs';
import {analyzePullRequestStep} from '../src/incremental-review.mjs';

// Synthetic extensionless executables: deleted authorization/receipt programs
// have no added-line anchors, so a clean review is not supportable.
const deleted=[
  {filename:'bin/authorize-tenant',status:'removed',patch:'@@ -1 +0,0 @@\n-requireTenantAccess();'},
  {filename:'scripts/verify-receipt',status:'removed',patch:'@@ -1 +0,0 @@\n-rejectForgedEvidence();'},
  {filename:'tools/bin/validate-approval',status:'removed',patch:'@@ -1 +0,0 @@\n-checkApproval();'}
];
const modified={filename:'src/health.ts',status:'modified',patch:'@@ -1 +1 @@\n-oldStatus();\n+newStatus();'};
const sha='a'.repeat(40);

test('extensionless deleted executable files never count as fully reviewed',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const result=planner([...deleted,modified]);
    const selected=result.files||result.batches.flat();
    assert.deepEqual(selected.map(f=>f.filename),['src/health.ts']);
    assert.equal(result.coverage.removedCode,3);
    assert.equal(result.coverage.reviewable,4);
    assert.equal(result.coverage.reviewed,1);
    assert.equal(result.coverage.complete,false);
  }
});

test('removed executable extensionless files fail closed in both review pipelines',async()=>{
  for(const run of [analyzePullRequest,analyzePullRequestStep]){
    const calls={reservations:0,models:0,posts:0,checkpoints:0};
    const deps={
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      installationToken:async()=> 'offline-synthetic',
      changedFiles:async()=>[...deleted,modified],
      reserveModelCalls:async()=>{calls.reservations++;return true;},
      reviewWithAI:async()=>{calls.models++;return {summary:'Clean',findings:[]};},
      postReview:async()=>{calls.posts++;return 'inline';},
      loadProgress:async()=>{calls.checkpoints++;return null;},
      initProgress:async()=>{calls.checkpoints++;return true;},
      saveProgress:async()=>{calls.checkpoints++;return true;}
    };
    const result=await run({repository:'sandbox/test',number:1,headSha:sha,
      installationId:3,reviewId:1,postMode:'live'},deps);
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.removedCode,3);
    assert.deepEqual(calls,{reservations:0,models:0,posts:0,checkpoints:0});
  }
});

test('ordinary deleted notes remain excluded without blocking valid code',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const result=planner([
      {filename:'docs/release-notes',status:'removed',patch:'@@ -1 +0,0 @@\n-old note'},
      modified
    ]);
    assert.equal(result.coverage.removedCode,0);
    assert.equal(result.coverage.excluded,1);
    assert.equal(result.coverage.complete,true);
  }
});

test('deleted dependency manifests are unreviewed, not silently excluded',()=>{
  const manifests=[
    {filename:'pyproject.toml',status:'removed',patch:'@@ -1 +0,0 @@\n-[tool.pytest.ini_options]'},
    {filename:'Cargo.toml',status:'removed',patch:'@@ -1 +0,0 @@\n-[dependencies]'},
    {filename:'services/worker/go.mod',status:'removed',patch:'@@ -1 +0,0 @@\n-module example/worker'}
  ];
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const result=planner([...manifests,modified]);
    assert.equal(result.coverage.removedCode,3);
    assert.equal(result.coverage.reviewable,4);
    assert.equal(result.coverage.reviewed,1);
    assert.equal(result.coverage.complete,false);
  }
});

test('deleted manifest guards fail closed before any model or review output',async()=>{
  const manifests=[
    {filename:'pyproject.toml',status:'removed',patch:'@@ -1 +0,0 @@\n-[tool.pytest.ini_options]'},
    {filename:'Cargo.toml',status:'removed',patch:'@@ -1 +0,0 @@\n-[dependencies]'},
    {filename:'services/worker/go.mod',status:'removed',patch:'@@ -1 +0,0 @@\n-module example/worker'}
  ];
  for(const run of [analyzePullRequest,analyzePullRequestStep]){
    const calls={reservations:0,models:0,posts:0,checkpoints:0};
    const deps={
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      installationToken:async()=> 'offline-synthetic',
      changedFiles:async()=>[...manifests,modified],
      reserveModelCalls:async()=>{calls.reservations++;return true;},
      reviewWithAI:async()=>{calls.models++;return {summary:'Clean',findings:[]};},
      postReview:async()=>{calls.posts++;return 'inline';},
      loadProgress:async()=>{calls.checkpoints++;return null;},
      initProgress:async()=>{calls.checkpoints++;return true;},
      saveProgress:async()=>{calls.checkpoints++;return true;}
    };
    const result=await run({repository:'sandbox/test',number:1,headSha:sha,
      installationId:3,reviewId:1,postMode:'live'},deps);
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.removedCode,3);
    assert.deepEqual(calls,{reservations:0,models:0,posts:0,checkpoints:0});
  }
});


test('removed generated dependency locks cannot silently count as complete coverage',()=>{
  const locks=[
    {filename:'package-lock.json',status:'removed',patch:'@@ -1 +0,0 @@\n-old-lock'},
    {filename:'pnpm-lock.yaml',status:'removed',patch:'@@ -1 +0,0 @@\n-old-lock'},
    {filename:'apps/site/yarn.lock',status:'removed',patch:'@@ -1 +0,0 @@\n-old-lock'}
  ];
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const result=planner([...locks,modified]);
    assert.equal(result.coverage.removedCode,3);
    assert.equal(result.coverage.reviewable,4);
    assert.equal(result.coverage.reviewed,1);
    assert.equal(result.coverage.complete,false);
  }
});

test('removed lockfiles fail closed before model/quota/post/checkpoints in both pipelines',async()=>{
  const locks=[
    {filename:'package-lock.json',status:'removed',patch:'@@ -1 +0,0 @@\n-old'},
    {filename:'pnpm-lock.yaml',status:'removed',patch:'@@ -1 +0,0 @@\n-old'},
    {filename:'yarn.lock',status:'removed',patch:'@@ -1 +0,0 @@\n-old'}
  ];
  for(const run of [analyzePullRequest,analyzePullRequestStep]){
    const calls={reservations:0,models:0,posts:0,checkpoints:0};
    const deps={
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      installationToken:async()=> 'offline-synthetic',
      changedFiles:async()=>[...locks,modified],
      reserveModelCalls:async()=>{calls.reservations++;return true;},
      reviewWithAI:async()=>{calls.models++;return {summary:'Clean',findings:[]};},
      postReview:async()=>{calls.posts++;return 'inline';},
      loadProgress:async()=>{calls.checkpoints++;return null;},
      initProgress:async()=>{calls.checkpoints++;return true;},
      saveProgress:async()=>{calls.checkpoints++;return true}
    };
    const result=await run({repository:'sandbox/test',number:1,headSha:sha,
      installationId:3,reviewId:1,postMode:'live'},deps);
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.removedCode,3);
    assert.deepEqual(calls,{reservations:0,models:0,posts:0,checkpoints:0});
  }
});

test('routine generated lockfile edits and deleted notes remain excluded',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const result=planner([
      {filename:'package-lock.json',status:'modified',patch:'@@ -1 +1 @@\n-old\n+new'},
      {filename:'docs/release-notes',status:'removed',patch:'@@ -1 +0,0 @@\n-old'},
      modified
    ]);
    assert.equal(result.coverage.excluded,2);
    assert.equal(result.coverage.removedCode,0);
    assert.equal(result.coverage.complete,true);
  }
});


// Deleting ecosystem checksum/lockfiles removes dependency-integrity evidence.
// These are intentionally synthetic files, not customer/Production data.
const ecosystemLocks=[
  'Cargo.lock','services/api/go.sum','Gemfile.lock',
  'web/bun.lockb','packages/ui/uv.lock','composer.lock'
].map(filename=>({filename,status:'removed',patch:'@@ -1 +0,0 @@\n-old checksum'}));

test('deleted ecosystem lockfiles fail closed in both file and batch planners',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const result=planner([...ecosystemLocks,modified]);
    assert.equal(result.coverage.removedCode,ecosystemLocks.length);
    assert.equal(result.coverage.reviewable,ecosystemLocks.length+1);
    assert.equal(result.coverage.reviewed,1);
    assert.equal(result.coverage.complete,false);
    const selected=result.files||result.batches.flat();
    assert.deepEqual(selected.map(f=>f.filename),['src/health.ts']);
  }
});

test('deleted ecosystem lockfiles never trigger model reservation or a clean posted review',async()=>{
  for(const run of [analyzePullRequest,analyzePullRequestStep]){
    const calls={reservations:0,models:0,posts:0,checkpoints:0};
    const deps={
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      installationToken:async()=> 'synthetic',
      changedFiles:async()=>[...ecosystemLocks,modified],
      reserveModelCalls:async()=>{calls.reservations++;return true;},
      reviewWithAI:async()=>{calls.models++;return {summary:'Clean',findings:[]};},
      postReview:async()=>{calls.posts++;return 'inline';},
      loadProgress:async()=>{calls.checkpoints++;return null;},
      initProgress:async()=>{calls.checkpoints++;return true;},
      saveProgress:async()=>{calls.checkpoints++;return true;}
    };
    const result=await run({repository:'sandbox/reviewforge-fixture',number:1,
      headSha:sha,installationId:3,reviewId:1,postMode:'live'},deps);
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.removedCode,ecosystemLocks.length);
    assert.deepEqual(calls,{reservations:0,models:0,posts:0,checkpoints:0});
  }
});
