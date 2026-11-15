import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PR5,EXPECTED_PATHS,preparePr5,runMockPr5,preflightPr5}
  from '../benchmarks/pr5-offline-preflight.mjs';

const target=process.env.RF_PR5_TARGET;
const frozenTest=target?test:test.skip;
const journal=t=>{
  const root=mkdtempSync(join(tmpdir(),'rf-pr5-offline-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return root;
};
const report=root=>JSON.parse(readFileSync(join(root,'result.json'),'utf8'));

frozenTest('exact frozen source is 8/8 in one real ReviewForge batch',async()=>{
  const p=await preparePr5(target);
  assert.equal(p.metadata.headSha,PR5.headSha);
  assert.equal(p.coverage.totalChanged,8);
  assert.equal(p.coverage.reviewed,8);
  assert.equal(p.coverage.reviewable,8);
  assert.equal(p.coverage.complete,true);
  assert.equal(p.coverage.batches,1);
  assert.deepEqual(new Set(p.batch.map(f=>f.filename)),new Set(EXPECTED_PATHS));
  assert.ok(p.pinnedReads>0);
  assert.ok(p.transmittedContextChars<=12000);
  assert.equal(p.reviewContext.projectRules,'');
  assert.ok(p.reviewContext.snippets.every(s=>EXPECTED_PATHS.includes(s.path)));
});

frozenTest('real parser and journal accept one synthetic response with no network',async t=>{
  const p=await preparePr5(target),root=journal(t);
  const originalFetch=globalThis.fetch;
  let unexpectedNetwork=0;
  globalThis.fetch=async()=>{unexpectedNetwork++;throw new Error('REAL_NETWORK_FORBIDDEN');};
  try{
    const run=await runMockPr5(p,root);
    assert.equal(run.report.status,'completed');
    assert.equal(run.report.modelAttemptCount,1);
    assert.equal(run.report.independentQualityMeasured,false);
    assert.equal(run.report.githubWrites,0);
    assert.equal(run.syntheticRequests,1);
    assert.ok(run.requestBytes>0 && run.requestBytes<=50000);
    assert.equal(unexpectedNetwork,0);
    assert.equal(report(root).providerUsage.httpStatus,200);
    assert.equal(report(root).providerUsage.inputTokens,17);
    assert.equal(JSON.parse(readFileSync(join(root,'result.json.dispatch.json'),'utf8')).maximumRequests,1);
    await assert.rejects(runMockPr5(p,root),/PREVIOUS_ATTEMPT_EXISTS/);
  }finally{globalThis.fetch=originalFetch;}
});

frozenTest('bad JSON and HTTP failure remain unverified and cannot retry',async t=>{
  const p=await preparePr5(target);
  for(const [scenario,status,http] of [
    ['bad-json','invalid_response_unverified',200],
    ['http-503','error_unverified',503],
    ['timeout','timeout_unverified',null]
  ]){
    const root=journal(t);
    await assert.rejects(runMockPr5(p,root,{scenario}),/REVIEW_NOT_COMPLETED/);
    assert.equal(report(root).status,status);
    assert.equal(report(root).providerUsage?.httpStatus??null,http);
    assert.equal(report(root).findings,null);
    await assert.rejects(runMockPr5(p,root),/PREVIOUS_ATTEMPT_EXISTS/);
  }
});

frozenTest('wrong frozen identity cannot start a journal',async t=>{
  const p=await preparePr5(target),root=journal(t);
  await assert.rejects(runMockPr5({...p,metadata:{...p.metadata,
    headSha:'a'.repeat(40)}},root),/FROZEN_PR5_PREPARED_IDENTITY_REQUIRED/);
  await assert.rejects(runMockPr5({...p,metadata:{...p.metadata,
    engineSha:'b'.repeat(40)}},root),/FROZEN_PR5_PREPARED_IDENTITY_REQUIRED/);
  assert.equal(existsSync(join(root,'attempt.lock')),false);
});

frozenTest('request cap blocks before dispatch and synthetic fetch',async t=>{
  const p=await preparePr5(target),root=journal(t);
  await assert.rejects(runMockPr5(p,root,{maxRequestBytes:1}),/REVIEW_NOT_COMPLETED/);
  assert.equal(report(root).modelAttemptCount,0);
  assert.equal(report(root).status,'error_unverified');
  assert.equal(existsSync(join(root,'result.json.dispatch.json')),false);
  await assert.rejects(runMockPr5(p,root),/PREVIOUS_ATTEMPT_EXISTS/);
});

frozenTest('filtered suggestion cannot become a clean verdict',async t=>{
  const p=await preparePr5(target),root=journal(t);
  await assert.rejects(runMockPr5(p,root,{scenario:'unanchored'}),/REVIEW_NOT_COMPLETED/);
  assert.equal(report(root).status,'error_unverified');
  assert.equal(report(root).findings,null);
});

frozenTest('synthetic token is redacted from private journal',async t=>{
  const p=await preparePr5(target),root=journal(t);
  const run=await runMockPr5(p,root,{scenario:'secret'});
  assert.equal(run.report.findings.length,1);
  const persisted=readFileSync(join(root,'result.json'),'utf8');
  assert.ok(!persisted.includes('SYNTHETICPR5TOKEN123456789'));
  assert.ok(persisted.includes('[REDACTED_TOKEN]'));
});

frozenTest('paid credentials and non-disposable journals are refused',async t=>{
  const p=await preparePr5(target),root=journal(t);
  const previous=process.env.OPENAI_TEST_API_KEY;
  process.env.OPENAI_TEST_API_KEY='synthetic-test-value';
  try{await assert.rejects(runMockPr5(p,root),/OFFLINE_ONLY_CREDENTIAL_ENV_FORBIDDEN/);}
  finally{
    if(previous===undefined)delete process.env.OPENAI_TEST_API_KEY;
    else process.env.OPENAI_TEST_API_KEY=previous;
  }
  assert.equal(existsSync(join(root,'attempt.lock')),false);
  await assert.rejects(runMockPr5(p,join(root,'nested')),
    /OFFLINE_DISPOSABLE_JOURNAL_REQUIRED/);
});

frozenTest('CLI preflight reports only safe telemetry and no AI quality',async()=>{
  const r=await preflightPr5(target);
  assert.equal(r.coverage.reviewed,8);
  assert.equal(r.realProviderRequests,0);
  assert.equal(r.quality,'NOT_MEASURED');
  assert.equal(r.futureAttempt,PR5.futureAttempt);
});
