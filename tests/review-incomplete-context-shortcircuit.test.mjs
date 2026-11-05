import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';
import { config } from '../src/config.mjs';

test('incomplete PR diff short-circuits optional context before remote fetches or paid work',async()=>{
  const repo='synthetic/context-review',sha='b'.repeat(40);
  const previous=config.aiContextRepositories;
  config.aiContextRepositories=[repo];
  const calls={context:0,reserve:0,model:0,checkpoint:0,post:0};
  try{
    const result=await analyzePullRequestStep({
      reviewId:943,repository:repo,number:943,headSha:sha,
      installationId:7,postMode:'dry-run',allowDraft:false
    },{
      installationToken:async()=> 'synthetic-token',
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      changedFiles:async()=>[
        {filename:'src/api/payments.ts',status:'modified',
          patch:'@@ -0,0 +1,1 @@\n+const value=1;'},
        {filename:'src/queue.ts',status:'modified'} // missing GitHub patch
      ],
      collectReviewContext:async()=>{
        calls.context++;
        throw new Error('Optional context must not be fetched for known incomplete coverage');
      },
      reserveModelCalls:async()=>{calls.reserve++;return {allowed:true};},
      reviewWithAI:async()=>{calls.model++;return {summary:'mock',findings:[]};},
      loadProgress:async()=>{calls.checkpoint++;return null;},
      initProgress:async()=>{calls.checkpoint++;return true;},
      saveProgress:async()=>{calls.checkpoint++;return true;},
      postReview:async()=>{calls.post++;throw Error('No posting allowed');}
    });
    assert.equal(result.status,'partial');
    assert.equal(result.coverage.missingPatch,1);
    assert.equal(result.posted,0);
    assert.deepEqual(calls,{context:0,reserve:0,model:0,checkpoint:0,post:0});
    assert.match(result.summary,/no AI calls made/i);
  }finally{
    config.aiContextRepositories=previous;
  }
});
