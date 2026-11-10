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


test('offline network failure remains unverified with no unexpected retries',async t=>{
  const paths=setup(t);let calls=0;
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>{
      calls++;
      throw new TypeError('Synthetic ENETUNREACH sk-proj-SYNTHETIC-SECRET-DO-NOT-STORE');
    }
  }),/REVIEW_NOT_COMPLETED/);
  const report=read(paths.reportPath);
  assert.equal(calls,1);
  assert.equal(report.status,'error_unverified');
  assert.equal(report.modelAttemptCount,1);
  assert.equal(report.findings,null);
  assert.equal(report.providerUsage,null);
  assert.equal(report.independentQualityMeasured,false);
  assert.ok(!readFileSync(paths.reportPath,'utf8').includes('SYNTHETIC-SECRET'));
});

test('two simultaneous identical-SHA attempts share one durable lock',async t=>{
  const paths=setup(t);
  let entered=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const args={...paths,files:makeFiles(),reviewContext:context(),metadata:meta()};
  const first=runOfflineJournaledReview({
    ...args,mockFetch:async()=>{
      entered++;
      await gate;
      return successful();
    }
  });
  await assert.rejects(runOfflineJournaledReview({
    ...args,mockFetch:async()=>{
      entered++;
      throw new Error('Duplicate request must never be sent');
    }
  }),/PREVIOUS_ATTEMPT_EXISTS/);
  release();
  assert.equal((await first).status,'completed');
  assert.equal(entered,1);
  assert.equal(read(paths.reportPath).modelAttemptCount,1);
});

test('mocked provider result cannot leak synthetic credentials into private report',async t=>{
  const paths=setup(t);
  const secret='sk-proj-SYNTHETICMODELKEY1234567890';
  const payload={
    status:'completed',
    output_text:JSON.stringify({
      summary:'Model echoed '+secret,
      findings:[{
        path:'src/lib/notification-lock.mjs',line:1,severity:'high',
        category:'correctness',title:'Unexpected '+secret,
        body:'Synthetic evidence '+secret+' should never be persisted.',
        confidence:0.99
      }]
    }),
    usage:{input_tokens:421,output_tokens:52}
  };
  const report=await runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>new Response(JSON.stringify(payload),{
      status:200,headers:{'x-request-id':'req_privatefixture42'}
    })
  });
  assert.equal(report.status,'completed');
  assert.equal(report.findings.length,1);
  assert.equal(report.providerUsage.inputTokens,421);
  const persisted=readFileSync(paths.reportPath,'utf8');
  assert.ok(!persisted.includes('SYNTHETICMODELKEY1234567890'));
  assert.ok(persisted.includes('[REDACTED_TOKEN]'));
  assert.equal(report.independentQualityMeasured,false);
});

test('unanchored suggestions cannot masquerade as a clean AI verdict',async t=>{
  const paths=setup(t);
  const result={
    status:'completed',output_text:JSON.stringify({
      summary:'Synthetic, knowingly unanchored suggestion',
      findings:[{path:'src/lib/notification-lock.mjs',line:99999,
        severity:'high',category:'correctness',title:'Unanchored claim',
        body:'This claim has no changed-line evidence.',confidence:0.98}]
    }),usage:{input_tokens:100,output_tokens:30}
  };
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>new Response(JSON.stringify(result),{status:200})
  }),/REVIEW_NOT_COMPLETED/);
  const report=read(paths.reportPath);
  assert.equal(report.status,'error_unverified');
  assert.equal(report.findings,null);
  assert.equal(report.providerUsage.inputTokens,100);
});

test('abrupt process exit after start keeps orphan lock without a fake clean report',async t=>{
  const {spawnSync}=await import('node:child_process');
  const {pathToFileURL,fileURLToPath}=await import('node:url');
  const paths=setup(t);
  const journalUrl=pathToFileURL(fileURLToPath(new URL('../benchmarks/one-shot-journal.mjs',import.meta.url))).href;
  const script=[
    'const {runSingleAttempt}=await import(process.argv[1]);',
    'const identity=JSON.parse(process.argv[4]);',
    'await runSingleAttempt({lockPath:process.argv[2],reportPath:process.argv[3],',
    'metadata:identity,execute:async({markModelRequestStart})=>{',
    'markModelRequestStart();process.exit(43);}});'
  ].join('');
  const child=spawnSync(process.execPath,
    ['--input-type=module','-e',script,journalUrl,paths.lockPath,paths.reportPath,JSON.stringify(meta())],
    {encoding:'utf8',timeout:5000});
  assert.equal(child.status,43,child.stderr);
  assert.equal(existsSync(paths.lockPath),true);
  assert.equal(existsSync(paths.reportPath),false);
  const {inspectAttempt}=await import('../benchmarks/one-shot-journal.mjs');
  const orphan=inspectAttempt(paths);
  assert.equal(orphan.status,'orphaned_unverified');
  assert.equal(orphan.modelAttemptCount,null);
  let calls=0;
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:async()=>{calls++;return successful();}
  }),/PREVIOUS_ATTEMPT_EXISTS/);
  assert.equal(calls,0);
});

test('crash after mocked HTTP receipt recovers tokens without invented verdict',async t=>{
  const {spawnSync}=await import('node:child_process');
  const {pathToFileURL,fileURLToPath}=await import('node:url');
  const paths=setup(t);
  const journalUrl=pathToFileURL(fileURLToPath(new URL('../benchmarks/one-shot-journal.mjs',import.meta.url))).href;
  const script=[
    'const {runSingleAttempt}=await import(process.argv[1]);',
    'const identity=JSON.parse(process.argv[4]);',
    'await runSingleAttempt({lockPath:process.argv[2],reportPath:process.argv[3],',
    'metadata:identity,execute:async({markModelRequestStart,recordProviderUsage})=>{',
    'markModelRequestStart();',
    'recordProviderUsage({httpStatus:200,inputTokens:897,outputTokens:114,requestId:"req_mockcrash99"});',
    'process.exit(44);}});'
  ].join('');
  const child=spawnSync(process.execPath,
    ['--input-type=module','-e',script,journalUrl,paths.lockPath,paths.reportPath,JSON.stringify(meta())],
    {encoding:'utf8',timeout:5000});
  assert.equal(child.status,44,child.stderr);
  assert.equal(existsSync(paths.reportPath),false);
  assert.equal(existsSync(paths.reportPath+'.usage.json'),true);
  const {inspectAttempt}=await import('../benchmarks/one-shot-journal.mjs');
  const recovered=inspectAttempt(paths);
  assert.equal(recovered.status,'orphaned_unverified');
  assert.equal(recovered.modelAttemptCount,1);
  assert.equal(recovered.providerUsage.inputTokens,897);
  assert.equal(recovered.providerUsage.outputTokens,114);
  assert.equal(recovered.hasFindings??false,false);
});
