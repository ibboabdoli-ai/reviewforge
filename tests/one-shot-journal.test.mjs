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