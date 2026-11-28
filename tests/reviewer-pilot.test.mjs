import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY='test-only-no-network-key';
const {reviewWithAI}=await import('../src/reviewer.mjs');
const file={filename:'src/example.ts',patch:'@@ -0,0 +1 @@\n+export const ok = true;'};

test('pilot rejects unapproved model and oversized input before provider use',async()=>{
  const old=globalThis.fetch;
  let called=0;
  globalThis.fetch=async()=>{called++;throw new Error('unexpected network call');};
  try{
    await assert.rejects(reviewWithAI([file],{model:'gpt-4.1-mini',profferaPilot:true}),/cost envelope/);
    await assert.rejects(reviewWithAI([{...file,patch:'x'.repeat(100001)}],
      {model:'gpt-6-luna',profferaPilot:true}),/cost envelope/);
    assert.equal(called,0);
  }finally{globalThis.fetch=old;}
});

test('unfinished provider response cannot become a clean pilot verdict',async()=>{
  const old=globalThis.fetch;
  globalThis.fetch=async()=>({ok:true,json:async()=>({status:'incomplete',output_text:'{"summary":"clean","findings":[]}'})});
  try{
    await assert.rejects(reviewWithAI([file],{model:'gpt-6-luna',profferaPilot:true}),/did not complete/);
  }finally{globalThis.fetch=old;}
});
