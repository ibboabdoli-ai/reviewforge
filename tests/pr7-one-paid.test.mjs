import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TRIAL,trialPaths,calculateCost,verifyAuthorization,
  preflightOnly,runApprovedOnce} from '../benchmarks/pr7-one-paid.mjs';
import {FROZEN_PR7,verifyFrozenBatch} from '../benchmarks/offline-journaled-review.mjs';
const names=[
  '.github/workflows/heldout-lock-check.yml','package.json',
  'src/lib/booking-repository.mjs','src/lib/mock-transaction-pool.mjs',
  'src/lib/notice-format.mjs','src/lib/notification-lock.mjs',
  'src/lib/workspace-capabilities.mjs','src/services/booking-notice.mjs',
  'src/services/deposit-reminder.mjs','src/services/deposit-updates.mjs',
  'tests/booking-notice.test.mjs','tests/deposit-reminder.test.mjs',
  'tests/notice-lifecycle.integration.test.mjs','tests/notification-lock.test.mjs',
  'tests/workspace-format.test.mjs'
];
const files=()=>names.map(filename=>({filename,status:'added',
  patch:'@@ -0,0 +1,1 @@\n+export const syntheticOnly = true;'}));
const ctx=()=>({headSha:TRIAL.head,totalChars:180,projectRules:'',
  snippets:[{path:'src/lib/notification-lock.mjs',kind:'changed-file-excerpt',
    text:'L1: benign synthetic lock excerpt'}],testLinks:[]});
const prepared=()=>{
  const input=files();
  const metadata={...FROZEN_PR7,engineSha:'f'.repeat(40)};
  const batch=verifyFrozenBatch({files:input,reviewContext:ctx(),metadata});
  return {files:input,batch,reviewContext:ctx(),metadata,
    coverage:{complete:true,reviewed:15},pinnedReads:0};
};
const fakeSuccess=()=>new Response(JSON.stringify({status:'completed',
  output_text:JSON.stringify({summary:'MOCK ONLY',findings:[]}),
  usage:{input_tokens:921,output_tokens:103}}),{status:200,
  headers:{'x-request-id':'req_testmock42'}});
const withTemp=t=>{
  const path=mkdtempSync(join(tmpdir(),'rf-independent-attempt-test-'));
  const original=process.env.TMPDIR;
  process.env.TMPDIR=path;
  t.after(()=>{if(original===undefined)delete process.env.TMPDIR;
    else process.env.TMPDIR=original;
    rmSync(path,{recursive:true,force:true});});
  return trialPaths(path);
};
test('immutable target, single batch, model caps',()=>{
  assert.equal(TRIAL.head,'a628945d7533c7418aed344ed5f90a9a2ec8bc46');
  assert.equal(TRIAL.model,'gpt-6.1-sol');
  assert.equal(TRIAL.effort,'high');
  assert.equal(TRIAL.maxOutputTokens,6000);
  assert.equal(TRIAL.maxRequestBytes,50000);
  assert.equal(verifyFrozenBatch({files:files(),reviewContext:ctx(),
    metadata:prepared().metadata}).length,15);
});
test('cost estimated from actual receipt values, not guessed tokens',()=>{
  assert.equal(calculateCost({inputTokens:10000,outputTokens:5000}),0.07);
  assert.equal(calculateCost({inputTokens:null,outputTokens:100}),null);
  assert.equal(calculateCost({inputTokens:-1,outputTokens:100}),null);
});
test('missing fresh authorization blocks any provider request',async t=>{
  const paths=withTemp(t);let fetches=0;
  await assert.rejects(runApprovedOnce({prepared:prepared(),paths,
    key:'sk-proj-LOCALTESTKEY123456789',approval:'wrong',
    fetchOnce:async()=>{fetches++;return fakeSuccess();}}),
  /FRESH_PAID_APPROVAL_REQUIRED/);
  assert.equal(fetches,0);assert.equal(existsSync(paths.lockPath),false);
});
test('preflight never uses a real fetch or model',async t=>{
  withTemp(t);const original=globalThis.fetch;let outgoing=0;
  globalThis.fetch=async()=>{outgoing++;throw Error('Network forbidden');};
  try{
    const result=await preflightOnly(prepared());
    assert.equal(outgoing,0);assert.equal(result.networkCalls,0);
    assert.equal(result.modelCalls,0);assert.equal(result.coverage.reviewed,15);
  }finally{globalThis.fetch=original;}
});
test('single synthetic POST records tokens and rejects rerun',async t=>{
  const paths=withTemp(t);let calls=0;
  const args={prepared:prepared(),paths,approval:TRIAL.id,
    key:'sk-proj-LOCALTESTKEY123456789',
    fetchOnce:async()=>{calls++;return fakeSuccess();}};
  const result=await runApprovedOnce(args);
  assert.equal(result.status,'completed');assert.equal(result.quality,'UNSCORED');
  assert.equal(result.providerUsage.inputTokens,921);
  assert.equal(result.estimatedUsd,(921*2+103*10)/1000000);
  assert.equal(calls,1);
  assert.ok(!readFileSync(paths.reportPath,'utf8').includes('LOCALTESTKEY'));
  await assert.rejects(runApprovedOnce(args),/ONE_SHOT_ATTEMPT_ALREADY_USED/);
  assert.equal(calls,1);
});
test('HTTP 503 saves failed receipt without a retry',async t=>{
  const paths=withTemp(t);let calls=0;
  const args={prepared:prepared(),paths,approval:TRIAL.id,
    key:'sk-proj-LOCALTESTKEY123456789',
    fetchOnce:async()=>{calls++;return new Response(JSON.stringify({
      error:{message:'synthetic'}}),{status:503});}};
  await assert.rejects(runApprovedOnce(args),/REVIEW_NOT_COMPLETED/);
  assert.equal(calls,1);
  const saved=JSON.parse(readFileSync(paths.reportPath,'utf8'));
  assert.notEqual(saved.status,'completed');
  assert.equal(saved.providerUsage.httpStatus,503);
  await assert.rejects(runApprovedOnce(args),/ONE_SHOT_ATTEMPT_ALREADY_USED/);
  assert.equal(calls,1);
});
test('historical lock remains untouched',async t=>{
  const paths=withTemp(t),{writeFileSync}=await import('node:fs');
  const original='{"old":true,"status":"unknown"}';
  writeFileSync(paths.oldLockPath,original);
  await preflightOnly(prepared());
  assert.equal(readFileSync(paths.oldLockPath,'utf8'),original);
});
