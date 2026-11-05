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
