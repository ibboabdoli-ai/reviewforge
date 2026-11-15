import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,existsSync,writeFileSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {preparePr5,PR5,assertPreparedPr5Provenance}
  from '../benchmarks/pr5-offline-preflight.mjs';
import {V6,attemptFiles,assertAttemptUnused,verifyFreshApproval,
  runApprovedV6,stageNames,preflightV6} from '../benchmarks/pr5-v6-one-shot.mjs';
import {inspectAttempt} from '../benchmarks/one-shot-journal.mjs';

const target=process.env.RF_PR5_TARGET;
const hosted=process.env.GITHUB_ACTIONS==='true' &&
  process.env.CI==='true' && process.env.RF_V6_DISPOSABLE_CI==='true' && !!target;
const hostedTest=(name,fn)=>test(name,{skip:!hosted},fn);
const key='sk-proj-SYNTHETICLOCALTESTONLY123456';
const artifacts=p=>[p.lockPath,p.reportPath,p.reportPath+'.usage.json',
  p.reportPath+'.dispatch.json',p.manifestPath,p.nodeStages,p.shellStages];
const answer=()=>Response.json({status:'completed',
  output_text:JSON.stringify({summary:'Offline synthetic response only',findings:[]}),
  usage:{input_tokens:120,output_tokens:30}});
function fixture(t,{parentPid=process.ppid}={}){
  if(!hosted)throw new Error('V6_STABLE_JOURNAL_TEST_REQUIRES_DISPOSABLE_CI');
  const paths=attemptFiles();
  for(const path of artifacts(paths))
    assert.equal(existsSync(path),false,'Never touch an existing attempt artifact');
  mkdirSync(dirname(paths.lockPath),{recursive:true,mode:0o700});
  const prior={};
  for(const name of ['RF_V6_PINNED_ENGINE','RF_APPROVED_PAID_ATTEMPT',
    'RF_V6_LAUNCH_NONCE'])prior[name]=process.env[name];
  const nonce='0123456789abcdef0123456789abcdef';
  process.env.RF_V6_PINNED_ENGINE=process.env.RF_V6_ENGINE_SHA;
  process.env.RF_APPROVED_PAID_ATTEMPT=V6.id;
  process.env.RF_V6_LAUNCH_NONCE=nonce;
  writeFileSync(paths.shellStages,JSON.stringify({schema:1,attempt:V6.id,
    stage:'node_launching',utc:new Date().toISOString(),shellPid:parentPid,
    launchSha256:createHash('sha256').update(nonce).digest('hex')})+'\n',
    {flag:'wx',mode:0o600,flush:true});
  t.after(()=>{
    for(const [name,value] of Object.entries(prior)){
      if(value===undefined)delete process.env[name];
      else process.env[name]=value;
    }
    if(!hosted)return;
    for(const path of artifacts(paths))rmSync(path,{force:true});
  });
  return paths;
}
const prepared=()=>preparePr5(target);
const saved=path=>JSON.parse(readFileSync(path,'utf8'));

test('V6 identity and future path are distinct from old attempts',()=>{
  assert.equal(V6.id,'rf-pr5-audited-once-20261115-v6');
  assert.equal(V6.id,PR5.futureAttempt);
  assert.ok(attemptFiles().lockPath.endsWith(V6.id+'.lock'));
  assert.ok(!attemptFiles().lockPath.includes('pr7'));
});

test('prepared source cannot be changed after pinned collection',
  {skip:!target},async()=>{
    const p=await prepared();
    assert.doesNotThrow(()=>assertPreparedPr5Provenance(p));
    p.batch[0].patch+='\n+untrusted modification';
    assert.throws(()=>assertPreparedPr5Provenance(p),
      /FROZEN_PR5_PREPARED_PROVENANCE_REQUIRED/);
  });

hostedTest('full frozen PR5 preflight is offline and leaves future lock unused',async()=>{
  const result=await preflightV6(target);
  assert.equal(result.targetHead,PR5.headSha);
  assert.equal(result.coverage.reviewed,8);
  assert.equal(result.coverage.complete,true);
  assert.equal(result.realProviderRequests,0);
  assertAttemptUnused();
});

hostedTest('approval, key, pinned engine and live shell trace are required',async t=>{
  const paths=fixture(t);
  assert.throws(()=>verifyFreshApproval({approval:'wrong',key,paths}),
    /FRESH_V6_APPROVAL_REQUIRED/);
  assert.throws(()=>verifyFreshApproval({approval:V6.id,key:'wrong',paths}),
    /PRIVATE_TEST_KEY_REQUIRED/);
  process.env.RF_V6_PINNED_ENGINE='a'.repeat(40);
  assert.throws(()=>verifyFreshApproval({approval:V6.id,key,paths}),
    /PINNED_V6_ENV_APPROVAL_REQUIRED/);
  assert.equal(existsSync(paths.nodeStages),false);
});

hostedTest('one synthetic response records one request and blocks replay',async t=>{
  const p=await prepared(),paths=fixture(t);let calls=0;
  const opts={prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>{calls++;return answer();}};
  const result=await runApprovedV6(opts);
  assert.equal(result.status,'completed');
  assert.equal(result.modelAttemptCount,1);
  assert.equal(result.providerUsage.inputTokens,120);
  assert.equal(calls,1);
  assert.equal(saved(paths.reportPath).githubWrites,0);
  const manifest=saved(paths.manifestPath);
  assert.equal(manifest.engineSha,process.env.RF_V6_ENGINE_SHA);
  assert.equal(manifest.headSha,PR5.headSha);
  assert.equal(manifest.coverage.reviewed,8);
  assert.equal(manifest.coverage.batches,1);
  assert.equal(manifest.pinnedReads,8);
  assert.equal(manifest.requestBytes,19603);
  assert.match(manifest.requestSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(new Set(manifest.changedFiles.map(f=>f.path)),
    new Set(p.batch.map(f=>f.filename)));
  assert.ok(manifest.changedFiles.every(f=>/^[a-f0-9]{64}$/.test(f.patchSha256)));
  assert.equal(inspectAttempt(paths).status,'completed');
  for(const stage of ['node_started','dispatch_persisted','fetch_invoked',
    'usage_persisted','report_persisted'])assert.ok(stageNames(paths.nodeStages).includes(stage));
  const persisted=readFileSync(paths.reportPath,'utf8')+
    readFileSync(paths.nodeStages,'utf8')+readFileSync(paths.manifestPath,'utf8');
  assert.ok(!persisted.includes('SYNTHETICLOCALTESTONLY'));
  assert.ok(!persisted.includes('FILE:'));
  await assert.rejects(runApprovedV6(opts),/V6_ATTEMPT_HAS_EVIDENCE/);
  assert.equal(calls,1);
});

hostedTest('an orphaned request manifest alone prevents a second request',async t=>{
  const p=await prepared(),paths=fixture(t);let calls=0;
  writeFileSync(paths.manifestPath,'{}',{flag:'wx',mode:0o600,flush:true});
  await assert.rejects(runApprovedV6({prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>{calls++;return answer();}
  }),/V6_ATTEMPT_HAS_EVIDENCE/);
  assert.equal(calls,0);
  assert.equal(existsSync(paths.nodeStages),false);
});

hostedTest('an unknown V6 partial file also blocks a new request',async t=>{
  const p=await prepared(),paths=fixture(t);let calls=0;
  const partial=paths.reportPath+'.partial-synthetic';
  writeFileSync(partial,'synthetic',{flag:'wx'});
  t.after(()=>rmSync(partial,{force:true}));
  await assert.rejects(runApprovedV6({prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>{calls++;return answer();}
  }),/V6_ATTEMPT_HAS_EVIDENCE/);
  assert.equal(calls,0);
});

hostedTest('timeout stays unverified with durable dispatch and no retry',async t=>{
  const p=await prepared(),paths=fixture(t);let calls=0;
  const opts={prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>{calls++;throw new DOMException('synthetic','TimeoutError');}};
  await assert.rejects(runApprovedV6(opts),/V6_UNVERIFIED/);
  assert.equal(calls,1);
  assert.equal(saved(paths.reportPath).status,'timeout_unverified');
  assert.equal(saved(paths.reportPath+'.dispatch.json').maximumRequests,1);
  await assert.rejects(runApprovedV6(opts),/V6_ATTEMPT_HAS_EVIDENCE/);
});

hostedTest('HTTP error cannot become a clean result',async t=>{
  const p=await prepared(),paths=fixture(t);
  await assert.rejects(runApprovedV6({prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>Response.json({error:{message:'synthetic'}},{status:503})
  }),/V6_UNVERIFIED/);
  assert.equal(saved(paths.reportPath).status,'error_unverified');
  assert.equal(saved(paths.reportPath).providerUsage.httpStatus,503);
  assert.equal(saved(paths.reportPath).findings,null);
});

hostedTest('failed shell cannot authorize a request',async t=>{
  const p=await prepared(),paths=fixture(t);let calls=0;
  appendFileSync(paths.shellStages,JSON.stringify({attempt:V6.id,
    stage:'shell_terminal_failure',utc:new Date().toISOString()})+'\n');
  await assert.rejects(runApprovedV6({prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>{calls++;return answer();}
  }),/STALE_OR_UNRELATED_POWERSHELL_LAUNCH/);
  assert.equal(calls,0);
  assert.equal(existsSync(paths.nodeStages),false);
});

hostedTest('wrong launch nonce cannot authorize a request',async t=>{
  const p=await prepared(),paths=fixture(t);
  process.env.RF_V6_LAUNCH_NONCE='abcdefabcdefabcdefabcdefabcdefab';
  await assert.rejects(runApprovedV6({prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>{throw new Error('MUST_NOT_CALL');}
  }),/LAUNCH_PROOF_MISMATCH/);
  assert.equal(existsSync(paths.nodeStages),false);
});

hostedTest('wrong parent PID cannot authorize a request',async t=>{
  const p=await prepared(),paths=fixture(t,{parentPid:999999});
  await assert.rejects(runApprovedV6({prepared:p,paths,approval:V6.id,key,
    requestFetch:async()=>{throw new Error('MUST_NOT_CALL');}
  }),/STALE_OR_UNRELATED_POWERSHELL_LAUNCH/);
  assert.equal(existsSync(paths.nodeStages),false);
});
