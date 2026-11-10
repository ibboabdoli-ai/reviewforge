import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FROZEN_PR7,verifyFrozenBatch,runOfflineJournaledReview} from '../benchmarks/offline-journaled-review.mjs';

const HEAD=FROZEN_PR7.headSha;
const PATHS=[
  '.github/workflows/heldout-lock-check.yml','package.json',
  'src/lib/booking-repository.mjs','src/lib/mock-transaction-pool.mjs',
  'src/lib/notice-format.mjs','src/lib/notification-lock.mjs',
  'src/lib/workspace-capabilities.mjs','src/services/booking-notice.mjs',
  'src/services/deposit-reminder.mjs','src/services/deposit-updates.mjs',
  'tests/booking-notice.test.mjs','tests/deposit-reminder.test.mjs',
  'tests/notice-lifecycle.integration.test.mjs','tests/notification-lock.test.mjs',
  'tests/workspace-format.test.mjs'
];
const makeFiles=()=>PATHS.map(filename=>({
  filename,status:'added',patch:'@@ -0,0 +1,1 @@\n+export const syntheticOnly = true;'
}));
const context=()=>({
  headSha:HEAD,totalChars:180,projectRules:'',
  snippets:[{path:'src/lib/notification-lock.mjs',
    kind:'changed-file-excerpt',text:'L1: synthetic lock fixture excerpt'}],
  testLinks:[]
});
const meta=()=>({...FROZEN_PR7,engineSha:'b'.repeat(40)});
const setup=t=>{
  const root=mkdtempSync(join(tmpdir(),'rf-offline-journal-review-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return {lockPath:join(root,'attempt.lock'),reportPath:join(root,'result.json')};
};
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const successful=()=>new Response(JSON.stringify({
  status:'completed',output_text:JSON.stringify({
    summary:'Mocked engine response; no actual AI review',findings:[]}),
  usage:{input_tokens:119,output_tokens:17}
}),{status:200,headers:{'x-request-id':'req_mocked12345'}});

test('frozen PR7 synthetic batch stays 15/15 with critical file paths',()=>{
  const batch=verifyFrozenBatch({files:makeFiles(),reviewContext:context(),metadata:meta()});
  assert.equal(new Set(batch.map(f=>f.filename)).size,15);
  for(const key of ['src/lib/notification-lock.mjs',
    'src/services/deposit-updates.mjs','src/services/deposit-reminder.mjs',
    'src/services/booking-notice.mjs'])assert.ok(batch.some(f=>f.filename===key));
});

test('real reviewer pipeline consumes ONE mocked response and persists usage',async t=>{
  const paths=setup(t);let fakeCalls=0;
  const report=await runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async (url,opts)=>{
      fakeCalls++;
      assert.equal(String(url),'https://api.openai.com/v1/responses');
      assert.equal(opts.method,'POST');
      assert.equal(opts.signal.aborted,false);
      const body=JSON.parse(opts.body);
      assert.equal(body.store,false);
      assert.equal(body.model,'gpt-6.1-sol');
      assert.equal(body.reasoning.effort,'high');
      assert.equal(body.max_output_tokens,6000);
      assert.ok(body.input.includes('src/lib/notification-lock.mjs'));
      assert.ok(body.input.includes('src/services/deposit-updates.mjs'));
      assert.ok(body.input.includes('src/services/booking-notice.mjs'));
      return successful();
    }
  });
  assert.equal(fakeCalls,1);
  assert.equal(report.status,'completed');
  assert.equal(report.modelAttemptCount,1);
  assert.equal(report.providerUsage.httpStatus,200);
  assert.equal(report.providerUsage.inputTokens,119);
  assert.equal(report.providerUsage.outputTokens,17);
  assert.ok(!readFileSync(paths.reportPath,'utf8').includes('sk-LOCAL'));
  assert.equal(report.independentQualityMeasured,false);
  assert.equal(report.githubWrites,0);
  assert.equal(read(paths.reportPath+'.usage.json').providerUsage.requestId,'req_mocked12345');
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>{fakeCalls++;throw Error('must not run');}
  }),/PREVIOUS_ATTEMPT_EXISTS/);
  assert.equal(fakeCalls,1,'Never replay an attempted review');
});

test('a model TimeoutError records an unverified outcome without replay',async t=>{
  const paths=setup(t);let calls=0;
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>{calls++;throw new DOMException('synthetic timeout','TimeoutError');}
  }),/REVIEW_NOT_COMPLETED/);
  assert.equal(calls,1);
  assert.equal(read(paths.reportPath).status,'timeout_unverified');
  assert.equal(read(paths.reportPath).modelAttemptCount,1);
  assert.equal(read(paths.reportPath).findings,null);
});

test('HTTP 503 is persisted but never treated as a clean review',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>new Response(JSON.stringify({error:{message:'synthetic unavailable'}}),{status:503})
  }),/REVIEW_NOT_COMPLETED/);
  assert.equal(read(paths.reportPath).status,'error_unverified');
  assert.equal(read(paths.reportPath).providerUsage.httpStatus,503);
  assert.equal(read(paths.reportPath).findings,null);
});

test('invalid JSON still captures observed HTTP response metadata',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>new Response('not json',{status:200})
  }),/REVIEW_NOT_COMPLETED/);
  const report=read(paths.reportPath);
  assert.equal(report.status,'invalid_response_unverified');
  assert.equal(report.providerUsage.httpStatus,200);
  assert.equal(report.providerUsage.inputTokens,null);
  assert.equal(report.findings,null);
});

test('wrong immutable HEAD fails before any lock or model call',async t=>{
  const paths=setup(t);let calls=0;
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:{...meta(),headSha:'a'.repeat(40)},
    mockFetch:async()=>{calls++;return successful();}
  }),/FROZEN_PR7_IDENTITY_MISMATCH/);
  assert.equal(calls,0);
  assert.equal(existsSync(paths.lockPath),false);
});

test('changed-file omission fails before any lock or model call',async t=>{
  const paths=setup(t);let calls=0;
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles().slice(1),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>{calls++;return successful();}
  }),/FROZEN_PR7_CHANGED_FILE_SET_MISMATCH/);
  assert.equal(calls,0);
  assert.equal(existsSync(paths.lockPath),false);
});

test('external production fetch and environment key are not accepted',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:globalThis.fetch
  }),/OFFLINE_ONLY_NO_REAL_KEY_OR_FETCH/);
  assert.equal(existsSync(paths.lockPath),false);
});
