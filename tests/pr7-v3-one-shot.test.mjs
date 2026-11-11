import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,existsSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {FROZEN_PR7,verifyFrozenBatch} from '../benchmarks/offline-journaled-review.mjs';
import {NEW_ATTEMPT_ID,attemptFiles,assertNewAttemptUnused,
  getStageNames,verifyOneShotApproval,runApprovedV3,preflightV3,executingEngineSha}
  from '../benchmarks/pr7-v3-one-shot.mjs';
import {inspectAttempt} from '../benchmarks/one-shot-journal.mjs';

const NAMES=[
  '.github/workflows/heldout-lock-check.yml','package.json',
  'src/lib/booking-repository.mjs','src/lib/mock-transaction-pool.mjs',
  'src/lib/notice-format.mjs','src/lib/notification-lock.mjs',
  'src/lib/workspace-capabilities.mjs','src/services/booking-notice.mjs',
  'src/services/deposit-reminder.mjs','src/services/deposit-updates.mjs',
  'tests/booking-notice.test.mjs','tests/deposit-reminder.test.mjs',
  'tests/notice-lifecycle.integration.test.mjs',
  'tests/notification-lock.test.mjs','tests/workspace-format.test.mjs'
];
const ctx=()=>({headSha:FROZEN_PR7.headSha,totalChars:180,projectRules:'',
  snippets:[{path:'src/lib/notification-lock.mjs',kind:'changed-file-excerpt',
    text:'L1: safe synthetic code excerpt'}],testLinks:[]});
const prepared=()=>{
  const files=NAMES.map(filename=>({filename,status:'added',
    patch:'@@ -0,0 +1,1 @@\n+export const placeholderOnly = true;'}));
  const metadata={...FROZEN_PR7,engineSha:'a'.repeat(40)};
  const context=ctx();
  return {metadata,reviewContext:context,batch:verifyFrozenBatch({
    files,reviewContext:context,metadata}),
    files,coverage:{reviewed:15,complete:true,batches:1}};
};
const key='sk-proj-SYNTHETICLOCALTESTONLY123456';
const answer=()=>new Response(JSON.stringify({
  status:'completed',
  output_text:JSON.stringify({summary:'SYNTHETIC ONLY',findings:[]}),
  usage:{input_tokens:170,output_tokens:29}
}),{status:200,headers:{'x-request-id':'req_syntheticv3'}});

const artifactList=paths=>[
  paths.lockPath,paths.reportPath,paths.reportPath+'.usage.json',
  paths.reportPath+'.dispatch.json',paths.nodeStages,paths.shellStages
];
function ciFixture(t,{parentPid=process.ppid}={}){
  if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true')
    throw new Error('REQUIRES_DISPOSABLE_HOSTED_CI');
  const paths=attemptFiles();
  for(const f of artifactList(paths))
    assert.equal(existsSync(f),false,'Never touch pre-existing one-shot evidence');
  mkdirSync(dirname(paths.shellStages),{recursive:true,mode:0o700});
  const previous=process.env.RF_V3_LAUNCH_NONCE;
  const nonce='1234567890abcdef1234567890abcdef';
  process.env.RF_V3_LAUNCH_NONCE=nonce;
  const freshLaunch={
    schema:1,attempt:NEW_ATTEMPT_ID,stage:'node_launching',
    utc:new Date().toISOString(),shellPid:parentPid,
    launchSha256:createHash('sha256').update(nonce).digest('hex')
  };
  writeFileSync(paths.shellStages,JSON.stringify(freshLaunch)+'\n',
    {flag:'wx',mode:0o600,flush:true});
  t.after(()=>{
    if(previous===undefined)delete process.env.RF_V3_LAUNCH_NONCE;
    else process.env.RF_V3_LAUNCH_NONCE=previous;
    // Only the fixed V3 synthetic paths on disposable GitHub runners.
    if(process.env.GITHUB_ACTIONS!=='true'||process.env.CI!=='true')return;
    for(const file of artifactList(paths))
      rmSync(file,{force:true,recursive:true});
  });
  return paths;
}
test('new id and stable lock paths are distinct from every historical ID',()=>{
  assert.equal(NEW_ATTEMPT_ID,'rf-pr7-audited-once-20261111-v3');
  const paths=attemptFiles();
  assert.ok(paths.lockPath.includes('20261111-v3'));
  assert.ok(!paths.lockPath.includes('20261110-v2'));
  assert.ok(!paths.lockPath.includes('20261109'));
  assert.equal(NAMES.length,15);
});
test('preflight only uses frozen 15-file source selection and no provider',async()=>{
  const result=await preflightV3(prepared());
  assert.equal(result.coverage.reviewed,15);
  assert.equal(result.providerCalls,0);
  assert.equal(result.target,'a628945d7533c7418aed344ed5f90a9a2ec8bc46');
});
test('explicit fresh authorization and PowerShell stage required',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},t=>{
  const paths=ciFixture(t);
  assert.throws(()=>verifyOneShotApproval({approval:'old',key,paths}),
    /NEW_PAID_APPROVAL_REQUIRED/);
  assert.throws(()=>verifyOneShotApproval({approval:NEW_ATTEMPT_ID,key:'bad',paths}),
    /PRIVATE_TEST_KEY_REQUIRED/);
});
test('one synthetic reply records each stage and forbids duplicate POST',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t);let count=0;
  const args={prepared:prepared(),paths,key,approval:NEW_ATTEMPT_ID,
    requestFetch:async()=>{count++;return answer();}};
  const result=await runApprovedV3(args);
  assert.equal(result.status,'completed');
  assert.equal(count,1);
  assert.equal(result.providerUsage.inputTokens,170);
  const stages=getStageNames(paths.nodeStages);
  for(const s of ['node_started','fetch_intent_persisted','dispatch_persisted',
    'fetch_invoked','usage_persisted','report_persisted'])assert.ok(stages.includes(s));
  const payload=readFileSync(paths.nodeStages,'utf8')+
    readFileSync(paths.reportPath,'utf8');
  assert.ok(!payload.includes('SYNTHETICLOCALTESTONLY'));
  assert.ok(!payload.includes('FILE:'));
  assert.equal(inspectAttempt(paths).status,'completed');
  await assert.rejects(runApprovedV3(args),/NEW_ATTEMPT_ALREADY_HAS_EVIDENCE/);
  assert.equal(count,1);
});
test('synthetic timeout is unverified and never retried',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t);let calls=0;
  const opts={prepared:prepared(),paths,key,approval:NEW_ATTEMPT_ID,
    requestFetch:async()=>{calls++;throw new DOMException('SYNTHETIC','TimeoutError');}};
  await assert.rejects(runApprovedV3(opts),/ONE_SHOT_UNVERIFIED/);
  assert.equal(calls,1);
  assert.equal(JSON.parse(readFileSync(paths.reportPath,'utf8')).status,
    'timeout_unverified');
  assert.ok(getStageNames(paths.nodeStages).includes('failed_unverified'));
  await assert.rejects(runApprovedV3(opts),/NEW_ATTEMPT_ALREADY_HAS_EVIDENCE/);
});
test('network failure leaves no sensitive message or completed verdict',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t);
  await assert.rejects(runApprovedV3({prepared:prepared(),paths,key,
    approval:NEW_ATTEMPT_ID,
    requestFetch:async()=>{throw new TypeError('Synthetic ENETUNREACH secret EXAMPLE');}
  }),/ONE_SHOT_UNVERIFIED/);
  const text=readFileSync(paths.reportPath,'utf8')+
    readFileSync(paths.nodeStages,'utf8');
  assert.ok(!text.includes('EXAMPLE'));
  assert.equal(JSON.parse(readFileSync(paths.reportPath,'utf8')).status,
    'error_unverified');
});
test('concurrent same-id attempts cannot send a second request',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t);let calls=0,release;
  const hold=new Promise(done=>{release=done;});
  const opts={prepared:prepared(),paths,key,approval:NEW_ATTEMPT_ID,
    requestFetch:async()=>{calls++;await hold;return answer();}};
  const first=runApprovedV3(opts);
  await assert.rejects(runApprovedV3(opts),/NEW_ATTEMPT_ALREADY_HAS_EVIDENCE/);
  release();
  assert.equal((await first).status,'completed');
  assert.equal(calls,1);
});
test('failed final report persistence retains lock, receipt and safe stage',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t);let calls=0;
  await assert.rejects(runApprovedV3({
    prepared:prepared(),paths,key,approval:NEW_ATTEMPT_ID,
    requestFetch:async()=>{
      calls++;
      // Mock the destination becoming unwritable *after* the durable lock
      // and dispatch marker exist, without touching real user files.
      mkdirSync(paths.reportPath);
      return answer();
    }
  }),/ONE_SHOT_UNVERIFIED/);
  assert.equal(calls,1);
  assert.equal(existsSync(paths.lockPath),true);
  assert.equal(existsSync(paths.reportPath+'.usage.json'),true);
  assert.ok(getStageNames(paths.nodeStages).includes('failed_unverified'));
  assert.equal(getStageNames(paths.nodeStages).includes('report_persisted'),false);
});
test('force-crashed synthetic Node cannot clear a journal or replay',{
  skip:process.env.GITHUB_ACTIONS!=='true',timeout:12000
},async t=>{
  const paths=ciFixture(t,{parentPid:process.pid});
  const script=[
    "import {runApprovedV3,NEW_ATTEMPT_ID} from ",
    JSON.stringify(new URL('../benchmarks/pr7-v3-one-shot.mjs',import.meta.url).href),
    ";",
    "const p=JSON.parse(process.argv[1]);",
    "await runApprovedV3({prepared:p,approval:NEW_ATTEMPT_ID,",
    "key:'sk-proj-SYNTHETICLOCALTESTONLY123456',requestFetch:async()=>process.exit(72)});"
  ].join('');
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    script,JSON.stringify(prepared())],{encoding:'utf8',timeout:5000});
  assert.equal(child.status,72,child.stderr);
  assert.equal(existsSync(paths.lockPath),true);
  assert.equal(existsSync(paths.reportPath),false);
  assert.equal(inspectAttempt(paths).status,'orphaned_unverified');
  assert.equal(inspectAttempt(paths).requestStartRecorded,true);
  assert.ok(getStageNames(paths.nodeStages).includes('fetch_invoked'));
  let second=0;
  await assert.rejects(runApprovedV3({prepared:prepared(),paths,key,
    approval:NEW_ATTEMPT_ID,
    requestFetch:async()=>{second++;return answer();}
  }),/NEW_ATTEMPT_ALREADY_HAS_EVIDENCE/);
  assert.equal(second,0);
});


test('a terminated shell trace never authorizes a direct paid-like call',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t);
  const {appendFileSync}=await import('node:fs');
  appendFileSync(paths.shellStages,JSON.stringify({
    attempt:NEW_ATTEMPT_ID,stage:'shell_terminal_failure',
    utc:new Date().toISOString()
  })+'\n');
  let requests=0;
  await assert.rejects(runApprovedV3({
    prepared:prepared(),paths,approval:NEW_ATTEMPT_ID,key,
    requestFetch:async()=>{requests++;return answer();}
  }),/STALE_OR_UNRELATED_POWERSHELL_LAUNCH/);
  assert.equal(requests,0);
  assert.equal(existsSync(paths.nodeStages),false);
});
test('wrong parent PID prevents using historical launch evidence',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t,{parentPid:999999});
  await assert.rejects(runApprovedV3({
    prepared:prepared(),paths,approval:NEW_ATTEMPT_ID,key,
    requestFetch:async()=>{throw Error('should never reach provider');}
  }),/STALE_OR_UNRELATED_POWERSHELL_LAUNCH/);
  assert.equal(existsSync(paths.nodeStages),false);
});
test('incorrect ephemeral launch nonce blocks provider work',{
  skip:process.env.GITHUB_ACTIONS!=='true'
},async t=>{
  const paths=ciFixture(t);
  process.env.RF_V3_LAUNCH_NONCE='abcdefabcdefabcdefabcdefabcdefab';
  await assert.rejects(runApprovedV3({
    prepared:prepared(),paths,approval:NEW_ATTEMPT_ID,key,
    requestFetch:async()=>{throw Error('should never reach provider');}
  }),/LAUNCH_PROOF_MISMATCH/);
  assert.equal(existsSync(paths.nodeStages),false);
});
test('engine SHA always describes executing checkout rather than cwd',t=>{
  const sourceSha=executingEngineSha();
  assert.match(sourceSha,/^[a-f0-9]{40}$/i);
  const current=process.cwd();
  const other=mkdtempSync(join(tmpdir(),'rf-v3-different-cwd-'));
  try{
    process.chdir(other);
    assert.equal(executingEngineSha(),sourceSha);
  }finally{
    process.chdir(current);
    rmSync(other,{recursive:true,force:true});
  }
});
