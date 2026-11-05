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

test('staged incomplete-diff preflight must reject a PR superseded during file retrieval',async()=>{
  // Synthetic race: the first GET sees SHA A but the file listing belongs
  // to a newer SHA B. An incomplete result for A would be misleading.
  const sha='a'.repeat(40),newSha='b'.repeat(40);
  let currentSha=sha;
  const calls={github:0,context:0,reserve:0,model:0,checkpoint:0,post:0};
  const result=await analyzePullRequestStep({
    reviewId:9943,repository:'synthetic/stale-coverage',number:943,
    headSha:sha,installationId:7,postMode:'dry-run'
  },{
    installationToken:async()=> 'fake',
    githubApi:async()=>{calls.github++;return {head:{sha:currentSha},state:'open',draft:false};},
    changedFiles:async()=>{
      currentSha=newSha;
      return [{filename:'src/receipt.ts',status:'modified'}]; // no text patch
    },
    collectReviewContext:async()=>{calls.context++;throw Error('No context fetch');},
    reserveModelCalls:async()=>{calls.reserve++;return {allowed:true};},
    reviewWithAI:async()=>{calls.model++;throw Error('No model');},
    loadProgress:async()=>{calls.checkpoint++;return null;},
    initProgress:async()=>{calls.checkpoint++;return true;},
    saveProgress:async()=>{calls.checkpoint++;return true;},
    postReview:async()=>{calls.post++;throw Error('No post');}
  });
  assert.equal(result.status,'superseded',
    'Do not record incomplete coverage for a SHA whose PR head changed during diff retrieval');
  assert.ok(calls.github>=2,'A second HEAD read is needed for incomplete-diff provenance');
  assert.deepEqual({context:calls.context,reserve:calls.reserve,model:calls.model,
    checkpoint:calls.checkpoint,post:calls.post},
    {context:0,reserve:0,model:0,checkpoint:0,post:0});
});
