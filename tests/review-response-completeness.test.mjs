import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { reviewWithAI } from '../src/reviewer.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';
import { reviewFailureMessage } from '../src/review-telemetry.mjs';

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

test('completed provider response reports measured tokens and time without pricing guesses',async()=>{
  await mockResponse({status:'completed',output_text:JSON.stringify(clean),
    usage:{input_tokens:120,output_tokens:30,total_tokens:150}},async()=>{
    const result=await reviewWithAI(files);
    assert.deepEqual(result.telemetry.tokens,{inputTokens:120,outputTokens:30,totalTokens:150});
    assert.equal(result.telemetry.model,config.openai.model);
    assert.ok(Number.isSafeInteger(result.telemetry.durationMs));
    assert.equal('cost' in result.telemetry,false);
  });
  await mockResponse({status:'completed',output_text:JSON.stringify(clean),
    usage:{input_tokens:-1,output_tokens:30,total_tokens:29}},async()=>{
    assert.equal((await reviewWithAI(files)).telemetry.tokens,null);
  });
});

test('unfinished paid response retains provider usage on its terminal error',async()=>{
  await mockResponse({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},
    usage:{input_tokens:6000,output_tokens:123,total_tokens:6123},
    output_text:JSON.stringify(clean)},async()=>{
    let failure;
    try{await reviewWithAI(files);}catch(error){failure=error;}
    assert.match(failure.message,/did not complete/);
    assert.deepEqual(failure.telemetry.tokens,
      {inputTokens:6000,outputTokens:123,totalTokens:6123});
    const recorded=reviewFailureMessage(failure);
    assert.match(recorded,/totalTokens=6123/);
    assert.match(recorded,/durationMs=\d+/);
    assert.ok(recorded.length<=260);
  });
});

test('Proffera pilot refuses unpriced models and oversized input before provider fetch',async()=>{
  await mockResponse({status:'completed',output_text:JSON.stringify(clean)},async calls=>{
    await assert.rejects(reviewWithAI(files,{profferaPilot:true,model:'unpriced-model'}),/cost envelope/);
    await assert.rejects(reviewWithAI([{filename:'src/huge.ts',patch:'x'.repeat(100001)}],
      {profferaPilot:true,model:'gpt-6-luna'}),/cost envelope/);
    assert.equal(calls(),0);
  });
});

test('unfinished model output is terminal before checkpoint or fallback approval',async()=>{
  const sha='a'.repeat(40);let saved=0,posts=0;
  const deps={installationToken:async()=> 'test-token',
    githubApi:async()=>({head:{sha},state:'open',draft:false}),changedFiles:async()=>files,
    reserveModelCalls:async()=>true,loadProgress:async()=>null,initProgress:async()=>true,
    saveProgress:async()=>{saved++;return true;},postReview:async()=>{posts++;return 'inline';}};
  await mockResponse({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},
    usage:{input_tokens:6000,output_tokens:123,total_tokens:6123},
    output_text:JSON.stringify(clean)},async calls=>{
    await assert.rejects(analyzePullRequestStep({reviewId:1,repository:'test/sandbox',
      number:1,headSha:sha,installationId:1,postMode:'fallback'},deps),
      error=>error.nonRetryable===true && /complete|status/i.test(error.message) &&
        reviewFailureMessage(error).includes('totalTokens=6123'));
    assert.equal(calls(),1);assert.equal(saved,0);assert.equal(posts,0);
  });
});
