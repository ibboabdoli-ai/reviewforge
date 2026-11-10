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
const successful=()=>({
  kind:'response',httpStatus:200,requestId:'req_mocked12345',
  body:{status:'completed',output_text:JSON.stringify({
    summary:'Mocked engine response; no actual AI review',findings:[]}),
    usage:{input_tokens:119,output_tokens:17}}
});

test('frozen PR7 synthetic batch stays 15/15 with critical file paths',()=>{
  const batch=verifyFrozenBatch({files:makeFiles(),reviewContext:context(),metadata:meta()});
  assert.equal(new Set(batch.map(f=>f.filename)).size,15);
  for(const key of ['src/lib/notification-lock.mjs',
    'src/services/deposit-updates.mjs','src/services/deposit-reminder.mjs',
    'src/services/booking-notice.mjs'])assert.ok(batch.some(f=>f.filename===key));
});

test('real reviewer pipeline consumes ONE synthetic response and persists usage',async t=>{
  const paths=setup(t);
  const report=await runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:successful()
  });
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
    mockOutcome:successful()
  }),/PREVIOUS_ATTEMPT_EXISTS/);
});

test('a model TimeoutError records unverified with no replay',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:{kind:'timeout'}
  }),/REVIEW_NOT_COMPLETED/);
  assert.equal(read(paths.reportPath).status,'timeout_unverified');
  assert.equal(read(paths.reportPath).modelAttemptCount,1);
  assert.equal(read(paths.reportPath).findings,null);
});

test('HTTP 503 is persisted but never treated as a clean review',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:{kind:'response',httpStatus:503,body:{error:{message:'synthetic unavailable'}}}
  }),/REVIEW_NOT_COMPLETED/);
  assert.equal(read(paths.reportPath).status,'error_unverified');
  assert.equal(read(paths.reportPath).providerUsage.httpStatus,503);
  assert.equal(read(paths.reportPath).findings,null);
});

test('invalid JSON still captures observed HTTP response metadata',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:{kind:'raw',text:'not json'}
  }),/REVIEW_NOT_COMPLETED/);
  const report=read(paths.reportPath);
  assert.equal(report.status,'invalid_response_unverified');
  assert.equal(report.providerUsage.httpStatus,200);
  assert.equal(report.providerUsage.inputTokens,null);
  assert.equal(report.findings,null);
});

test('wrong immutable HEAD fails before any lock or model call',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:{...meta(),headSha:'a'.repeat(40)},
    mockOutcome:successful()
  }),/FROZEN_PR7_IDENTITY_MISMATCH/);
  assert.equal(existsSync(paths.lockPath),false);
});

test('changed-file omission fails before any lock or model call',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles().slice(1),reviewContext:context(),metadata:meta(),
    mockOutcome:successful()
  }),/FROZEN_PR7_CHANGED_FILE_SET_MISMATCH/);
  assert.equal(existsSync(paths.lockPath),false);
});

test('external production fetch and environment key are not accepted',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:globalThis.fetch
  }),/OFFLINE_ONLY_MOCK_FIXTURE_REQUIRED/);
  assert.equal(existsSync(paths.lockPath),false);
});


test('offline network failure remains unverified without retry',async t=>{
  const paths=setup(t);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:{kind:'network'}
  }),/REVIEW_NOT_COMPLETED/);
  const report=read(paths.reportPath);
  assert.equal(report.status,'error_unverified');
  assert.equal(report.modelAttemptCount,1);
  assert.equal(report.findings,null);
  assert.equal(report.providerUsage,null);
  assert.equal(report.independentQualityMeasured,false);
});

test('two simultaneous same-SHA requests share one durable lock',async t=>{
  const paths=setup(t),args={...paths,files:makeFiles(),reviewContext:context(),metadata:meta()};
  const first=runOfflineJournaledReview({...args,mockOutcome:{...successful(),delayMs:70}});
  await assert.rejects(runOfflineJournaledReview({...args,mockOutcome:successful()}),
    /PREVIOUS_ATTEMPT_EXISTS/);
  assert.equal((await first).status,'completed');
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
    mockOutcome:{kind:'response',httpStatus:200,body:payload,requestId:'req_privatefixture42'}
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
    mockOutcome:{kind:'response',httpStatus:200,body:result}
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
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:successful()
  }),/PREVIOUS_ATTEMPT_EXISTS/);
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

test('a forged low context counter cannot bypass 12k context limit',async t=>{
  const paths=setup(t),ctx=context();
  ctx.totalChars=1;
  ctx.snippets[0].text='L1: '+('Z'.repeat(12500));
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:ctx,metadata:meta(),
    mockOutcome:successful()
  }),/FROZEN_PR7_CONTEXT_MISSING_OR_UNTRUSTED/);
  assert.equal(existsSync(paths.lockPath),false);
});

test('a forwarding fetch wrapper is ignored even when passed alongside a mock fixture',async t=>{
  const paths=setup(t);let forwarded=0;
  const wrapper=(...args)=>{forwarded++;return globalThis.fetch(...args);};
  const report=await runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockFetch:wrapper,mockOutcome:successful()
  });
  assert.equal(report.status,'completed');
  assert.equal(forwarded,0);
});

test('an asynchronous pre-request instrumentation gate blocks fetch until settled',async()=>{
  const {reviewWithAI}=await import('../src/reviewer.mjs');
  const files=[{filename:'src/guard.ts',patch:'@@ -0,0 +1,1 @@\n+export const synthetic = true;'}];
  let release,attempts=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const ongoing=reviewWithAI(files,{
    requestKey:'sk-LOCAL-SYNTHETIC',model:'gpt-6.1-sol',
    requestFetch:async()=>{attempts++;return new Response(JSON.stringify({
      status:'completed',output_text:JSON.stringify({summary:'ok',findings:[]})
    }),{status:200});},
    onBeforeRequest:async()=>{await gate;}
  });
  await Promise.resolve();await Promise.resolve();
  assert.equal(attempts,0);
  release();
  const result=await ongoing;
  assert.equal(attempts,1);
  assert.equal(result.findings.length,0);
});

test('asynchronous rejected preflight prevents provider invocation',async()=>{
  const {reviewWithAI}=await import('../src/reviewer.mjs');
  let requests=0;
  await assert.rejects(reviewWithAI([
    {filename:'src/guard.ts',patch:'@@ -0,0 +1,1 @@\n+export const synthetic = true;'}
  ],{
    requestKey:'sk-LOCAL-SYNTHETIC',
    requestFetch:async()=>{requests++;throw Error('Should not fetch');},
    onBeforeRequest:async()=>{await Promise.resolve();throw Error('PRECHECK_DENIED');}
  }),/PRECHECK_DENIED/);
  assert.equal(requests,0);
});

test('asynchronous receipt persistence completes before the model verdict',async()=>{
  const {reviewWithAI}=await import('../src/reviewer.mjs');
  let signal,release,finished=false;
  const entered=new Promise(resolve=>{signal=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const pending=reviewWithAI([
    {filename:'src/guard.ts',patch:'@@ -0,0 +1,1 @@\n+export const synthetic = true;'}
  ],{
    requestKey:'sk-LOCAL-SYNTHETIC',
    requestFetch:async()=>new Response(JSON.stringify({
      status:'completed',output_text:JSON.stringify({summary:'ok',findings:[]}),
      usage:{input_tokens:7,output_tokens:5}
    }),{status:200}),
    onProviderReceipt:async()=>{signal();await hold;}
  }).then(x=>{finished=true;return x;});
  await entered;
  assert.equal(finished,false);
  release();
  await pending;
  assert.equal(finished,true);
});

test('inherited toJSON hooks cannot execute a network-capable mock fixture',async t=>{
  const paths=setup(t);let arbitraryHooks=0;
  const inherited=Object.create({toJSON(){arbitraryHooks++;return {status:'completed'};}});
  inherited.status='completed';
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:{kind:'response',body:inherited}
  }),/OFFLINE_ONLY_INERT_DATA_REQUIRED/);
  assert.equal(arbitraryHooks,0);
  assert.equal(existsSync(paths.lockPath),false);
});

test('accessor getters and own toJSON functions are rejected before any attempt lock',async t=>{
  const paths=setup(t);let accessed=0;
  const body={status:'completed',get output_text(){accessed++;return '{}';}};
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:{kind:'response',body}
  }),/OFFLINE_ONLY_INERT_DATA_REQUIRED/);
  assert.equal(accessed,0);
  assert.equal(existsSync(paths.lockPath),false);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:context(),metadata:meta(),
    mockOutcome:{kind:'response',body:{toJSON(){accessed++;return {};}}}
  }),/OFFLINE_ONLY_INERT_DATA_REQUIRED/);
  assert.equal(accessed,0);
});

test('oversized testLinks cannot bypass the exact emitted context budget',async t=>{
  const paths=setup(t),ctx=context();
  ctx.testLinks=[{test:'X'.repeat(12500),implementation:'src/lib/notification-lock.mjs'}];
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:ctx,metadata:meta(),
    mockOutcome:successful()
  }),/FROZEN_PR7_CONTEXT_MISSING_OR_UNTRUSTED/);
  assert.equal(existsSync(paths.lockPath),false);
});

test('oversized snippet kind cannot escape the context accounting',async t=>{
  const paths=setup(t),ctx=context();
  ctx.snippets[0].kind='Z'.repeat(12500);
  await assert.rejects(runOfflineJournaledReview({
    ...paths,files:makeFiles(),reviewContext:ctx,metadata:meta(),
    mockOutcome:successful()
  }),/FROZEN_PR7_CONTEXT_MISSING_OR_UNTRUSTED/);
  assert.equal(existsSync(paths.lockPath),false);
});
