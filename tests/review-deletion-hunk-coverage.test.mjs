import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFilesForReview, planReviewBatches, validateFindings } from '../src/reviewer.mjs';
import { analyzePullRequest } from '../src/pipeline.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';

const deletion={filename:'src/auth.mjs',status:'modified',
  patch:'@@ -1,3 +1,2 @@\n export function load(user) {\n-  requireAdmin(user);\n   return privateData;'};
const sha='d'.repeat(40);

test('deletion-only hunks cannot claim complete coverage without reportable anchors',()=>{
  // The existing validator cannot report this removed guard at any added line.
  assert.deepEqual(validateFindings([{path:deletion.filename,line:2,severity:'high',
    confidence:.99,title:'Removed authorization',body:'The removed guard allows private access.'}],
  [deletion]),[]);
  for(const planner of [selectFilesForReview,planReviewBatches]){
    for(const patch of [deletion.patch,
      deletion.patch+'\n@@ -20 +19 @@\n-oldName();\n+newName();',
      '--- a/src/auth.mjs\n+++ b/src/auth.mjs\n'+deletion.patch]){
      const result=planner([{...deletion,patch}]);
      assert.equal(result.coverage.complete,false);
      assert.equal(result.coverage.unanchoredDeletions,1);
      assert.equal(result.coverage.reviewed,0);
    }
  }
});

test('replacement and addition hunks still have eligible changed-line anchors',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    for(const patch of ['@@ -1 +1 @@\n-oldGuard();\n+newGuard();',
      '@@ -0,0 +1 @@\n+++counter;']){
      const result=planner([{...deletion,patch}]);
      assert.equal(result.coverage.complete,true);
      assert.equal(result.coverage.reviewed,1);
    }
  }
});

test('both pipelines stop deletion-only reviews before budget, AI, checkpoint or approval',async()=>{
  for(const analyze of [analyzePullRequest,analyzePullRequestStep]){
    const calls={budget:0,model:0,checkpoint:0,post:0};
    const deps={installationToken:async()=> 'synthetic',
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      changedFiles:async()=>[deletion],
      reserveModelCalls:async()=>{calls.budget++;return true;},
      reviewWithAI:async()=>{calls.model++;return {summary:'Clean',findings:[]};},
      loadProgress:async()=>{calls.checkpoint++;return null;},
      initProgress:async()=>{calls.checkpoint++;return true;},
      saveProgress:async()=>{calls.checkpoint++;return true;},
      postReview:async()=>{calls.post++;return 'inline';}};
    const result=await analyze({repository:'fixture/review',number:1,headSha:sha,
      installationId:1,reviewId:1,postMode:'fallback'},deps);
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.complete,false);
    assert.match(result.summary,/deletion-only hunk/);
    assert.deepEqual(calls,{budget:0,model:0,checkpoint:0,post:0});
  }
});
