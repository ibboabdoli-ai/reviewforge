import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSingleAttempt, inspectAttempt } from '../benchmarks/one-shot-journal.mjs';

const metadata = {
  repository: 'ibboabdoli-ai/reviewforge-sandbox', pr: 7,
  headSha: 'a628945d7533c7418aed344ed5f90a9a2ec8bc46',
  engineSha: '9e7ebb04359e87915f8bcf10510dafe42957cee3',
  model: 'gpt-6.1-sol'
};
const setup = t => {
  const root = mkdtempSync(join(tmpdir(), 'rf-one-shot-journal-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { lockPath: join(root, 'attempt.lock'), reportPath: join(root, 'result.json'),
    metadata };
};
const read = p => JSON.parse(readFileSync(p, 'utf8'));

test('successful model result and received token usage are recoverable', async t => {
  const target = setup(t);
  let started = 0;
  const answer = await runSingleAttempt({
    ...target, execute: async ({ markModelRequestStart, recordProviderUsage }) => {
      started++;
      markModelRequestStart();
      recordProviderUsage({ httpStatus: 200, inputTokens: 900, outputTokens: 190,
        requestId: 'req_7fake12345' });
      return { summary: 'Synthetic review completed',
        findings: [{path:'src/lib/notification-lock.mjs',line:13,severity:'high',
          title:'Synthetic lock defect',body:'Synthetic only'}],
        diagnostics: { modelSuggestions: 1, acceptedFindings: 1, filteredFindings: 0 } };
    }
  });
  assert.equal(started, 1);
  assert.equal(answer.status, 'completed');
  assert.equal(read(target.reportPath).findings.length, 1);
  assert.equal(read(target.reportPath).providerUsage.inputTokens, 900);
  assert.equal(read(target.reportPath + '.usage.json').providerUsage.outputTokens, 190);
  assert.equal(inspectAttempt(target).hasFindings, true);
  await assert.rejects(runSingleAttempt({
    ...target, execute: async () => { started++; }
  }), /PREVIOUS_ATTEMPT_EXISTS/);
  assert.equal(started, 1, 'No repeated provider work');
});

test('provider TimeoutError persists an unverified report, not a clean result', async t => {
  const target = setup(t);
  let calls = 0;
  await assert.rejects(runSingleAttempt({
    ...target, execute: async ({ markModelRequestStart }) => {
      markModelRequestStart(); calls++;
      throw new DOMException('sk-proj-REDACTTHISSECRETFAKE', 'TimeoutError');
    }
  }), /REVIEW_NOT_COMPLETED/);
  const result = read(target.reportPath);
  assert.equal(result.status, 'timeout_unverified');
  assert.equal(result.modelAttemptCount, 1);
  assert.equal(result.findings, null);
  assert.equal(result.providerUsage, null);
  assert.equal(result.independentQualityMeasured, false);
  assert.equal(result.costUsd, null);
  assert.ok(!readFileSync(target.reportPath, 'utf8').includes('REDACTTHISSECRETFAKE'));
  await assert.rejects(runSingleAttempt({
    ...target, execute: async () => { calls++; }
  }), /PREVIOUS_ATTEMPT_EXISTS/);
  assert.equal(calls, 1);
});

test('a real AbortSignal timeout is captured with no network or retry', async t => {
  const target = setup(t);
  await assert.rejects(runSingleAttempt({
    ...target, execute: async ({ markModelRequestStart }) => {
      markModelRequestStart();
      const signal = AbortSignal.timeout(15);
      await new Promise((resolve,reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {once:true});
      });
    }
  }), /REVIEW_NOT_COMPLETED/);
  assert.equal(read(target.reportPath).status, 'timeout_unverified');
  assert.equal(read(target.reportPath).modelAttemptCount, 1);
});

test('HTTP response usage is preserved even if later output validation fails', async t => {
  const target = setup(t);
  await assert.rejects(runSingleAttempt({
    ...target, execute: async ({ markModelRequestStart, recordProviderUsage }) => {
      markModelRequestStart();
      recordProviderUsage({httpStatus:200,inputTokens:1100,outputTokens:12});
      throw new SyntaxError('Provider output could not be parsed');
    }
  }), /REVIEW_NOT_COMPLETED/);
  const r = read(target.reportPath);
  assert.equal(r.status,'invalid_response_unverified');
  assert.equal(r.providerUsage.inputTokens,1100);
  assert.equal(r.independentQualityMeasured,false);
  assert.equal(read(target.reportPath+'.usage.json').providerUsage.httpStatus,200);
});

test('unsuccessful HTTP status cannot be misreported as a completed review', async t => {
  const target = setup(t);
  await assert.rejects(runSingleAttempt({
    ...target, execute: async ({ markModelRequestStart, recordProviderUsage }) => {
      markModelRequestStart();
      recordProviderUsage({httpStatus:503,inputTokens:null,outputTokens:null});
      throw new Error('HTTP 503');
    }
  }), /REVIEW_NOT_COMPLETED/);
  assert.equal(read(target.reportPath).status,'error_unverified');
  assert.equal(read(target.reportPath).providerUsage.httpStatus,503);
  assert.equal(read(target.reportPath).findings,null);
});

test('no model request due to safe-preflight rejection is distinguished from a paid attempt', async t => {
  const target = setup(t);
  await assert.rejects(runSingleAttempt({
    ...target, execute: async () => { throw new Error('Safe preflight rejected'); }
  }), /REVIEW_NOT_COMPLETED/);
  assert.equal(read(target.reportPath).modelAttemptCount,0);
  assert.equal(read(target.reportPath).providerOutcome,'not_started');
});

test('an incomplete result is not treated as a clean 0-findings verdict', async t => {
  const target=setup(t);
  await assert.rejects(runSingleAttempt({
    ...target, execute: async ({markModelRequestStart}) => {
      markModelRequestStart();
      return {summary:'no findings',findings:null};
    }
  }), /REVIEW_NOT_COMPLETED/);
  assert.equal(read(target.reportPath).status,'error_unverified');
  assert.equal(read(target.reportPath).findings,null);
});

test('orphaned legacy lock can be inspected without fetching or replaying model', async t => {
  const target=setup(t);
  writeFileSync(target.lockPath,JSON.stringify({
    pr:7,head:metadata.headSha,model:metadata.model,
    startedAt:'2026-11-09T21:05:05.637Z',attemptsAllowed:1
  }));
  const info=inspectAttempt(target);
  assert.equal(info.status,'orphaned_unverified');
  assert.equal(info.modelAttemptCount,null,'A lock alone cannot prove a paid HTTP call');
  assert.ok(!existsSync(target.reportPath));
});

test('two concurrent calls still execute only the first attempted request', async t => {
  const target = setup(t);
  let calls=0;
  let finish;
  const gate=new Promise(resolve=>{finish=resolve;});
  const first=runSingleAttempt({
    ...target, execute: async ({markModelRequestStart}) => {
      markModelRequestStart();calls++;
      await gate;
      return {summary:'done',findings:[]};
    }
  });
  await assert.rejects(runSingleAttempt({
    ...target, execute: async () => { calls++; }
  }), /PREVIOUS_ATTEMPT_EXISTS/);
  finish();
  await first;
  assert.equal(calls,1);
  assert.equal(inspectAttempt(target).status,'completed');
});

test('completed model output is redacted before writing a private report', async t => {
  const target=setup(t);
  await runSingleAttempt({
    ...target, execute: async ({markModelRequestStart}) => {
      markModelRequestStart();
      return {summary:'A secret sk-proj-EXAMPLESECRETABCDEFG was in the draft',
        findings:[{path:'src/secret.ts',line:3,severity:'high',category:'security',
          title:'Bad sk-proj-EXAMPLESECRETABCDEFG',body:'No echo sk-proj-EXAMPLESECRETABCDEFG',
          confidence:0.99}]};
    }
  });
  const text=readFileSync(target.reportPath,'utf8');
  assert.ok(!text.includes('EXAMPLESECRETABCDEFG'));
  assert.match(text,/REDACTED_TOKEN/);
});

test('known HTTP 503 cannot complete even if the callback returns success-shaped output', async t => {
  const target=setup(t);
  await assert.rejects(runSingleAttempt({
    ...target, execute: async ({markModelRequestStart,recordProviderUsage})=>{
      markModelRequestStart();
      recordProviderUsage({httpStatus:503,inputTokens:null,outputTokens:null});
      return {summary:'Looks successful',findings:[]};
    }
  }),/REVIEW_NOT_COMPLETED/);
  const result=read(target.reportPath);
  assert.notEqual(result.status,'completed');
  assert.equal(result.providerUsage.httpStatus,503);
  assert.equal(result.independentQualityMeasured,false);
});

test('provider diagnostics are numeric-only and cannot retain credentials', async t => {
  const target=setup(t);
  await runSingleAttempt({
    ...target, execute: async ({markModelRequestStart})=>{
      markModelRequestStart();
      return {summary:'ok',findings:[],
        diagnostics:{message:'sk-proj-DIAGNOSTICSSYNTHETICSECRET123',
          acceptedFindings:0,modelSuggestions:0,filteredFindings:0}};
    }
  });
  const body=readFileSync(target.reportPath,'utf8');
  assert.ok(!body.includes('DIAGNOSTICSSYNTHETICSECRET123'));
  assert.deepEqual(read(target.reportPath).diagnostics,{
    acceptedFindings:0,modelSuggestions:0,filteredFindings:0});
});

test('different locks cannot replace an existing report at the same path', async t => {
  const target=setup(t);
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const common={reportPath:target.reportPath,metadata:target.metadata};
  const execute=label=>async ({markModelRequestStart})=>{
    markModelRequestStart();
    await gate;
    return {summary:label,findings:[]};
  };
  const one=runSingleAttempt({...common,lockPath:target.lockPath,execute:execute('first')});
  const two=runSingleAttempt({...common,lockPath:target.lockPath+'.other',execute:execute('second')});
  release();
  const settled=await Promise.allSettled([one,two]);
  assert.equal(settled.filter(x=>x.status==='fulfilled').length,1,
    'No more than one successful writer may publish the shared report');
  assert.equal(settled.filter(x=>x.status==='rejected').length,1);
  assert.equal(read(target.reportPath).status,'completed');
});

test('successful report and usage receipts leave no private partial hard links', async t => {
  const target=setup(t);
  const {readdirSync}=await import('node:fs');
  const {dirname}=await import('node:path');
  await runSingleAttempt({
    ...target, execute: async ({markModelRequestStart,recordProviderUsage})=>{
      markModelRequestStart();
      recordProviderUsage({httpStatus:200,inputTokens:42,outputTokens:10});
      return {summary:'ok',findings:[]};
    }
  });
  const names=readdirSync(dirname(target.reportPath));
  assert.deepEqual(names.filter(name=>name.includes('.partial-')),[],
    'No secondary links to confidential reports or receipts may remain');
});

test('orphan inspection recovers trustworthy usage receipt without declaring model success', async t => {
  const target=setup(t);
  writeFileSync(target.lockPath,JSON.stringify({
    ...target.metadata,status:'started_unverified',startedAt:'2026-11-09T21:05:05.637Z'
  }));
  writeFileSync(target.reportPath+'.usage.json',JSON.stringify({
    ...target.metadata,recordedAt:'2026-11-09T21:05:31Z',
    providerUsage:{httpStatus:200,inputTokens:891,outputTokens:99,requestId:'req_syntheticreceipt9'}
  }));
  const info=inspectAttempt(target);
  assert.equal(info.status,'orphaned_unverified');
  assert.equal(info.modelAttemptCount,1);
  assert.equal(info.providerUsage.httpStatus,200);
  assert.equal(info.providerUsage.inputTokens,891);
  assert.equal(info.providerUsage.outputTokens,99);
  assert.ok(!info.hasFindings);
});

test('orphan receipt for another SHA cannot be trusted as usage evidence', async t => {
  const target=setup(t);
  writeFileSync(target.lockPath,JSON.stringify({
    ...target.metadata,status:'started_unverified',startedAt:'2026-11-09T21:05:05Z'
  }));
  writeFileSync(target.reportPath+'.usage.json',JSON.stringify({
    ...target.metadata,headSha:'b'.repeat(40),
    providerUsage:{httpStatus:200,inputTokens:20000,outputTokens:1000}
  }));
  const info=inspectAttempt(target);
  assert.equal(info.status,'orphaned_unverified');
  assert.equal(info.modelAttemptCount,null);
  assert.equal(info.providerUsage,null);
});

test('journal flushes lock and output files before a possible provider request', async t => {
  const {readFileSync}=await import('node:fs');
  const source=readFileSync(new URL('../benchmarks/one-shot-journal.mjs',import.meta.url),'utf8');
  assert.match(source,/writeFileSync\(lockPath,[\s\S]*?flush:\s*true/);
  assert.match(source,/writeFileSync\(temp,[\s\S]*?flush:\s*true/);
  assert.match(source,/syncParentDirectory\(lockPath\)/);
  assert.match(source,/fsyncSync\(fd\)/);
});

test('a private pre-fetch marker is persisted before synthetic provider work', async t => {
  const target=setup(t);let calls=0;
  await assert.rejects(runSingleAttempt({
    ...target,execute:async({markModelRequestStart})=>{
      markModelRequestStart();
      const marker=read(target.reportPath+'.dispatch.json');
      assert.equal(marker.stage,'before_fetch');
      assert.equal(marker.headSha,metadata.headSha);
      assert.equal(marker.maximumRequests,1);
      calls++;
      throw new DOMException('synthetic', 'TimeoutError');
    }
  }),/REVIEW_NOT_COMPLETED/);
  assert.equal(calls,1);
  assert.equal(read(target.reportPath).status,'timeout_unverified');
  assert.ok(!readFileSync(target.reportPath+'.dispatch.json','utf8').includes('sk-'));
  await assert.rejects(runSingleAttempt({...target,execute:async()=>{calls++;}}),
    /PREVIOUS_ATTEMPT_EXISTS/);
  assert.equal(calls,1);
});

test('abrupt exit after pre-fetch mark leaves recoverable evidence, not a verdict', async t => {
  const target=setup(t);
  const {spawnSync}=await import('node:child_process');
  // A file URL works on both POSIX and Windows drive-letter paths.
  const entry=new URL('../benchmarks/one-shot-journal.mjs',import.meta.url).href;
  const program=[
    'const {runSingleAttempt}=await import(process.argv[1]);',
    'await runSingleAttempt({lockPath:process.argv[2],reportPath:process.argv[3],',
    'metadata:JSON.parse(process.argv[4]),execute:async({markModelRequestStart})=>{',
    'markModelRequestStart();process.exit(73);}});'
  ].join('');
  const child=spawnSync(process.execPath,['--input-type=module','-e',program,
    entry,target.lockPath,target.reportPath,JSON.stringify(metadata)],
    {encoding:'utf8',timeout:5000});
  assert.equal(child.status,73,child.stderr);
  assert.equal(existsSync(target.lockPath),true);
  assert.equal(existsSync(target.reportPath),false);
  const recovered=inspectAttempt(target);
  assert.equal(recovered.status,'orphaned_unverified');
  assert.equal(recovered.requestStartRecorded,true);
  assert.equal(recovered.providerUsage,null);
  assert.equal(recovered.modelAttemptCount,null);
});

test('legacy orphan without stage marker cannot prove a model request', async t => {
  const target=setup(t);
  writeFileSync(target.lockPath,JSON.stringify({...metadata,
    status:'started_unverified',startedAt:'2026-11-11T08:10:00Z'}));
  const recovered=inspectAttempt(target);
  assert.equal(recovered.status,'orphaned_unverified');
  assert.equal(recovered.requestStartRecorded,null);
  assert.equal(recovered.providerUsage,null);
});

test('wrong SHA dispatch marker is not accepted as matching evidence', async t => {
  const target=setup(t);
  writeFileSync(target.lockPath,JSON.stringify({...metadata,
    status:'started_unverified',startedAt:'2026-11-11T08:10:00Z'}));
  writeFileSync(target.reportPath+'.dispatch.json',JSON.stringify({
    ...metadata,headSha:'e'.repeat(40),stage:'before_fetch'
  }));
  assert.equal(inspectAttempt(target).requestStartRecorded,null);
});

test('orphaned dispatch marker alone prevents replay even without lock', async t => {
  const target=setup(t);let calls=0;
  writeFileSync(target.reportPath+'.dispatch.json',JSON.stringify({
    ...metadata,stage:'before_fetch'
  }));
  await assert.rejects(runSingleAttempt({...target,
    execute:async()=>{calls++;}}),/PREVIOUS_ATTEMPT_EXISTS/);
  assert.equal(calls,0);
  assert.equal(existsSync(target.lockPath),false);
});
