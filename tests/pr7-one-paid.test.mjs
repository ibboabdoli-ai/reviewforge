import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TRIAL,trialPaths,stableJournalRoot,calculateCost,verifyAuthorization,
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
// Only CI can exercise the paid-like synthetic path under a disposable
// OS user. On a real technician laptop never touch the durable attempt lock.
const withTemp=t=>{
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true')
    throw new Error('SYNTHETIC_PAID_TEST_REQUIRES_EPHEMERAL_CI');
  const paths=trialPaths();
  assert.equal(existsSync(paths.lockPath),false,'Existing attempts must never be removed');
  assert.equal(existsSync(paths.reportPath),false,'Existing reports must never be removed');
  assert.equal(existsSync(paths.reportPath+'.usage.json'),false,'Existing usage must never be removed');
  assert.equal(existsSync(paths.reportPath+'.dispatch.json'),false,'Existing dispatch markers must never be removed');
  t.after(async()=>{
    // GitHub Actions runs under a disposable account; these are exclusively
    // synthetic artifacts created by this CI test, never a customer's lock.
    const {rmSync}=await import('node:fs');
    rmSync(paths.lockPath,{force:true});
    rmSync(paths.reportPath,{force:true});
    rmSync(paths.reportPath+'.usage.json',{force:true});
    rmSync(paths.reportPath+'.dispatch.json',{force:true});
  });
  return paths;
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
test('missing fresh authorization blocks any provider request',{skip:process.env.GITHUB_ACTIONS!=='true'},async t=>{
  const paths=withTemp(t);let fetches=0;
  await assert.rejects(runApprovedOnce({prepared:prepared(),paths,
    key:'sk-proj-LOCALTESTKEY123456789',approval:'wrong',
    fetchOnce:async()=>{fetches++;return fakeSuccess();}}),
  /FRESH_PAID_APPROVAL_REQUIRED/);
  assert.equal(fetches,0);assert.equal(existsSync(paths.lockPath),false);
});
test('preflight never uses a real fetch or model',async t=>{const original=globalThis.fetch;let outgoing=0;
  globalThis.fetch=async()=>{outgoing++;throw Error('Network forbidden');};
  try{
    const result=await preflightOnly(prepared());
    assert.equal(outgoing,0);assert.equal(result.networkCalls,0);
    assert.equal(result.modelCalls,0);assert.equal(result.coverage.reviewed,15);
  }finally{globalThis.fetch=original;}
});
test('single synthetic POST records tokens and rejects rerun',{skip:process.env.GITHUB_ACTIONS!=='true'},async t=>{
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
test('HTTP 503 saves failed receipt without a retry',{skip:process.env.GITHUB_ACTIONS!=='true'},async t=>{
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
test('durable journal path is unchanged by TEMP TMP or TMPDIR variations',()=>{
  const before=trialPaths();
  const original={TEMP:process.env.TEMP,TMP:process.env.TMP,
    TMPDIR:process.env.TMPDIR,HOME:process.env.HOME};
  try{
    for(const key of Object.keys(original))
      process.env[key]='/tmp/changed-for-synthetic-test';
    const after=trialPaths();
    assert.equal(before.lockPath,after.lockPath);
    assert.equal(before.reportPath,after.reportPath);
    assert.notEqual(before.lockPath,before.oldLockPath);
    assert.ok(stableJournalRoot().length>4);
  }finally{
    for(const [key,value] of Object.entries(original))
      if(value===undefined)delete process.env[key];
      else process.env[key]=value;
  }
});
test('preflight does not touch any simulated legacy lock',async t=>{
  const root=mkdtempSync(join(tmpdir(),'rf-legacy-simulated-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const {writeFileSync}=await import('node:fs');
  const legacy=join(root,'rf-heldout-pr7-paid-once-20261109.lock');
  const data='{"legacy":true,"providerOutcome":"unknown"}';
  writeFileSync(legacy,data);
  await preflightOnly(prepared());
  assert.equal(readFileSync(legacy,'utf8'),data);
});

test('unanchored model suggestions fail closed without a clean paid verdict',
  {skip:process.env.GITHUB_ACTIONS!=='true'},async t=>{
  const paths=withTemp(t);let requests=0;
  const reply=()=>new Response(JSON.stringify({
    status:'completed',output_text:JSON.stringify({
      summary:'Synthetic candidate with invalid changed-line anchor',
      findings:[{path:'src/lib/notification-lock.mjs',line:99999,
        severity:'high',category:'correctness',title:'Synthetic wrong anchor',
        body:'Not on an added line; must not be called clean.',confidence:0.96}]
    }),usage:{input_tokens:160,output_tokens:30}
  }),{status:200});
  const args={prepared:prepared(),paths,approval:TRIAL.id,
    key:'sk-proj-LOCALTESTKEY123456789',
    fetchOnce:async()=>{requests++;return reply();}};
  await assert.rejects(runApprovedOnce(args),/REVIEW_NOT_COMPLETED/);
  assert.equal(requests,1);
  const report=JSON.parse(readFileSync(paths.reportPath,'utf8'));
  assert.notEqual(report.status,'completed');
  assert.equal(report.findings,null);
  assert.equal(report.providerUsage.inputTokens,160);
  await assert.rejects(runApprovedOnce(args),/ONE_SHOT_ATTEMPT_ALREADY_USED/);
  assert.equal(requests,1);
});


test('a dispatch marker without the main lock prevents any paid-like retry',
  {skip:process.env.GITHUB_ACTIONS!=='true'},async t=>{
  const paths=withTemp(t);let calls=0;
  const {writeFileSync}=await import('node:fs');
  writeFileSync(paths.reportPath+'.dispatch.json',JSON.stringify({
    repository:'ibboabdoli-ai/reviewforge-sandbox',pr:7,
    headSha:TRIAL.head,engineSha:'f'.repeat(40),model:TRIAL.model,
    stage:'before_fetch'
  }));
  await assert.rejects(runApprovedOnce({
    prepared:prepared(),paths,approval:TRIAL.id,
    key:'sk-proj-LOCALTESTKEY123456789',
    fetchOnce:async()=>{calls++;return fakeSuccess();}
  }),/ONE_SHOT_ATTEMPT_ALREADY_USED/);
  assert.equal(calls,0);
});
