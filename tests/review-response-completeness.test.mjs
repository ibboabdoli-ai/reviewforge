import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { reviewWithAI } from '../src/reviewer.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';

const files=[{filename:'src/auth.mjs',patch:'@@ -1 +1 @@\n-oldCheck();\n+newCheck();'}];
const clean={summary:'No defects found.',findings:[]};
/** Run an offline provider-response scenario and restore credentials/fetch even on failure. */
async function mockResponse(data,run){
  const key=config.openai.apiKey,fetch=globalThis.fetch;
  config.openai.apiKey='synthetic-offline-only';
  let calls=0;
  globalThis.fetch=async url=>{
    assert.equal(url,'https://api.openai.com/v1/responses');calls++;
    return {ok:true,json:async()=>data};
  };
  try{return await run(()=>calls);}
  finally{config.openai.apiKey=key;globalThis.fetch=fetch;}
}

test('parseable text in an unfinished model response cannot become a clean review',async()=>{
  for(const status of ['incomplete','failed','cancelled','in_progress','queued',undefined]){
    await mockResponse({status,output_text:JSON.stringify(clean)},async()=>{
      await assert.rejects(reviewWithAI(files),/complete|status/i);
    });
  }
});

test('a completed response must contain the required review result fields',async()=>{
  for(const result of [{},{summary:'No issues'},{summary:'No issues',findings:null},
    {summary:4,findings:[]},[],null]){
    await mockResponse({status:'completed',output_text:JSON.stringify(result)},async()=>{
      await assert.rejects(reviewWithAI(files),/review result/i);
    });
  }
});

test('valid completed empty and grounded findings remain supported',async()=>{
  const finding={path:'src/auth.mjs',line:1,severity:'high',category:'security',
    title:'Synthetic issue',body:'A concrete synthetic defect for the fixture.',confidence:.9};
  for(const findings of [[],[finding]]){
    await mockResponse({status:'completed',output:[{type:'message',status:'completed',
      content:[{type:'output_text',text:JSON.stringify({...clean,findings})}]}]},async()=>{
      assert.deepEqual((await reviewWithAI(files)).findings,findings);
    });
  }
});

test('unfinished model output is terminal before checkpoint or fallback approval',async()=>{
  const sha='a'.repeat(40);let saved=0,posts=0;
  const deps={installationToken:async()=> 'test-token',
    githubApi:async()=>({head:{sha},state:'open',draft:false}),changedFiles:async()=>files,
    reserveModelCalls:async()=>true,loadProgress:async()=>null,initProgress:async()=>true,
    saveProgress:async()=>{saved++;return true;},postReview:async()=>{posts++;return 'inline';}};
  await mockResponse({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},
    output_text:JSON.stringify(clean)},async calls=>{
    await assert.rejects(analyzePullRequestStep({reviewId:1,repository:'test/sandbox',
      number:1,headSha:sha,installationId:1,postMode:'fallback'},deps),
      error=>error.nonRetryable===true && /complete|status/i.test(error.message));
    assert.equal(calls(),1);assert.equal(saved,0);assert.equal(posts,0);
  });
});
