import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFilesForReview, planReviewBatches } from '../src/reviewer.mjs';
import { analyzePullRequest } from '../src/pipeline.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';

// All strings and diffs are synthetic. The sensitive source content is never
// supplied to AI, and its presence must never be mistaken for full coverage.
const sha='c'.repeat(40);
const changes=[
  {filename:'.env.production',status:'modified',
    patch:'@@ -1 +1 @@\n-EXAMPLE_ONLY=before\n+EXAMPLE_ONLY=after'},
  {filename:'certs/test-signing.pem',status:'removed',
    patch:'@@ -1 +0,0 @@\n-TEST_FIXTURE_ONLY'},
  {filename:'src/lib/session.ts',status:'modified',
    patch:'@@ -1 +1 @@\n-export const valid=false;\n+export const valid=true;'}
];

test('sensitive additions or removals are counted as unreviewed, never sent to AI',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const result=planner(changes);
    const c=result.coverage;
    assert.equal(c.sensitiveUnreviewed,2);
    assert.equal(c.reviewable,3);
    assert.equal(c.reviewed,1);
    assert.equal(c.excluded,0);
    assert.equal(c.complete,false);
    const selected=result.files||result.batches.flat();
    assert.deepEqual(selected.map(f=>f.filename),['src/lib/session.ts']);
  }
});

test('legacy and staged review paths fail closed before quota, models, posts',async()=>{
  for(const analyze of [analyzePullRequest,analyzePullRequestStep]){
    const calls={reservations:0,models:0,posts:0,checkpoints:0};
    const deps={
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      installationToken:async()=> 'test-only',
      changedFiles:async()=>changes,
      reserveModelCalls:async()=>{calls.reservations++;return true;},
      reviewWithAI:async()=>{calls.models++;return {summary:'Untrusted clean',findings:[]};},
      postReview:async()=>{calls.posts++;return 'inline';},
      loadProgress:async()=>{calls.checkpoints++;return null;},
      initProgress:async()=>{calls.checkpoints++;return true;},
      saveProgress:async()=>{calls.checkpoints++;return true;}
    };
    const params={repository:'fixture/review',number:42,headSha:sha,installationId:12,postMode:'live',reviewId:42};
    const result=await analyze(params,deps);
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.complete,false);
    assert.equal(result.coverage.sensitiveUnreviewed,2);
    assert.match(result.summary,/sensitive path\(s\) withheld/);
    assert.deepEqual(calls,{reservations:0,models:0,posts:0,checkpoints:0});
  }
});
