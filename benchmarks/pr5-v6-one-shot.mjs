// Frozen PR5 V6: offline by default. The paid path requires separate future
// authorization and must never replay an existing attempt.
import {existsSync,mkdirSync,writeFileSync,appendFileSync,readFileSync,readdirSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,timingSafeEqual} from 'node:crypto';
import {preparePr5,preflightPr5,PR5,EXPECTED_PATHS,executingEngineSha,
  futureJournalRoot,assertBlindedPr5Request,assertPreparedPr5Provenance,
  assertCleanExecutingEngine}
  from './pr5-offline-preflight.mjs';
import {runSingleAttempt} from './one-shot-journal.mjs';
import {reviewWithAI} from '../src/reviewer.mjs';

export const V6=Object.freeze({
  id:PR5.futureAttempt,model:PR5.model,effort:'high',
  maxOutputTokens:6000,maxRequestBytes:50000,timeoutMs:180000
});
const STAGES=new Set([
  'node_started','preflight_verified','lock_request_begin','fetch_intent_persisted',
  'dispatch_persisted','fetch_invoked','usage_persisted','report_persisted',
  'failed_unverified'
]);
export function attemptFiles(root=futureJournalRoot()){
  return Object.freeze({
    lockPath:join(root,V6.id+'.lock'),
    reportPath:join(root,V6.id+'.result.json'),
    manifestPath:join(root,V6.id+'.request-manifest.json'),
    nodeStages:join(root,V6.id+'.node-stages.jsonl'),
    shellStages:join(root,V6.id+'.shell-stages.jsonl')
  });
}
export function assertAttemptUnused(paths=attemptFiles()){
  const fixed=attemptFiles();
  if(Object.keys(fixed).some(key=>paths?.[key]!==fixed[key]))
    throw new Error('V6_FIXED_OS_USER_JOURNAL_REQUIRED');
  if([paths.lockPath,paths.reportPath,paths.reportPath+'.usage.json',
      paths.reportPath+'.dispatch.json',paths.manifestPath,
      paths.nodeStages].some(existsSync))
    throw new Error('V6_ATTEMPT_HAS_EVIDENCE_DO_NOT_RETRY');
  let names=[];
  try{names=readdirSync(dirname(paths.lockPath));}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(names.some(name=>name.startsWith(V6.id) &&
       name!==V6.id+'.shell-stages.jsonl'))
    throw new Error('V6_ATTEMPT_HAS_EVIDENCE_DO_NOT_RETRY');
}
const sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
function persistRequestManifest(path,prepared,body){
  assertPreparedPr5Provenance(prepared);
  const requestBytes=Buffer.byteLength(body,'utf8');
  if(requestBytes>V6.maxRequestBytes || prepared.pinnedReads!==8 ||
     prepared.transmittedContextChars>12000)
    throw new Error('V6_MANIFEST_SOURCE_BOUNDS_FAILED');
  const manifest={schema:1,attempt:V6.id,
    repository:PR5.repository,pr:PR5.pr,baseSha:PR5.baseSha,
    headSha:PR5.headSha,engineSha:prepared.metadata.engineSha,
    model:V6.model,changedFiles:prepared.batch.map(file=>({
      path:file.filename,patchSha256:sha256(file.patch??'')})),
    coverage:{totalChanged:prepared.coverage.totalChanged,
      reviewed:prepared.coverage.reviewed,batches:prepared.coverage.batches,
      complete:prepared.coverage.complete,
      missingPatch:prepared.coverage.missingPatch,
      limitedSegments:prepared.coverage.limitedSegments},
    pinnedReads:prepared.pinnedReads,
    contextChars:prepared.transmittedContextChars,
    requestBytes,requestSha256:sha256(body)};
  writeFileSync(path,JSON.stringify(manifest,null,2),
    {flag:'wx',mode:0o600,flush:true});
}
function emitStage(path,stage,{create=false}={}){
  if(!STAGES.has(stage))throw new Error('INVALID_V6_STAGE');
  const line=JSON.stringify({schema:1,attempt:V6.id,stage,
    utc:new Date().toISOString()})+'\n';
  if(create)writeFileSync(path,line,{flag:'wx',mode:0o600,flush:true});
  else appendFileSync(path,line,{flag:'a',mode:0o600,flush:true});
}
export function stageNames(path){
  if(!existsSync(path))return [];
  return readFileSync(path,'utf8').split(/\r?\n/).filter(Boolean).map(line=>{
    const item=JSON.parse(line);
    if(item.attempt!==V6.id||!STAGES.has(item.stage))
      throw new Error('UNTRUSTED_V6_STAGE');
    return item.stage;
  });
}
function checkPaidEnvironment(){
  for(const name of ['OPENAI_API_KEY','DATABASE_URL','STRIPE_SECRET_KEY',
    'GITHUB_TOKEN','GITHUB_PRIVATE_KEY']){
    if(process.env[name])throw new Error('PRODUCTION_CREDENTIAL_ENV_FORBIDDEN');
  }
}
function safePrepared(prepared){
  if(prepared?.metadata?.repository!==PR5.repository ||
     prepared.metadata.pr!==PR5.pr ||
     prepared.metadata.headSha!==PR5.headSha ||
     prepared.metadata.engineSha!==executingEngineSha() ||
     prepared.metadata.model!==V6.model ||
     prepared.coverage?.complete!==true ||
     prepared.coverage.reviewed!==8 || prepared.coverage.reviewable!==8 ||
     prepared.coverage.batches!==1 || prepared.batch?.length!==8 ||
     new Set(prepared.batch.map(f=>f.filename)).size!==8 ||
     prepared.batch.some(f=>!EXPECTED_PATHS.includes(f.filename)) ||
     prepared.reviewContext?.headSha!==PR5.headSha ||
     prepared.reviewContext.projectRules!=='' ||
     !Array.isArray(prepared.reviewContext.snippets) ||
     prepared.reviewContext.snippets.some(s=>!EXPECTED_PATHS.includes(s.path)))
    throw new Error('FROZEN_PR5_V6_PREFLIGHT_REQUIRED');
  assertPreparedPr5Provenance(prepared);
}
export function verifyFreshApproval({approval,key,paths=attemptFiles()}){
  assertCleanExecutingEngine();
  checkPaidEnvironment();
  if(approval!==V6.id)throw new Error('FRESH_V6_APPROVAL_REQUIRED');
  if(process.env.RF_APPROVED_PAID_ATTEMPT!==V6.id ||
     process.env.RF_V6_PINNED_ENGINE!==executingEngineSha())
    throw new Error('PINNED_V6_ENV_APPROVAL_REQUIRED');
  if(typeof key!=='string'||!/^sk-(?:proj-)?[A-Za-z0-9_-]{15,}$/.test(key))
    throw new Error('PRIVATE_TEST_KEY_REQUIRED');
  assertAttemptUnused(paths);
  if(!existsSync(paths.shellStages))throw new Error('POWERSHELL_STAGE_REQUIRED');
  let last;
  try{
    const lines=readFileSync(paths.shellStages,'utf8').split(/\r?\n/).filter(Boolean);
    last=JSON.parse(lines.at(-1)??'null');
  }catch{throw new Error('POWERSHELL_LAUNCH_EVIDENCE_INVALID');}
  if(last?.attempt!==V6.id || last?.stage!=='node_launching' ||
     !Number.isSafeInteger(last.shellPid) || last.shellPid!==process.ppid ||
     !Number.isFinite(Date.parse(last.utc)) ||
     Math.abs(Date.now()-Date.parse(last.utc))>300000)
    throw new Error('STALE_OR_UNRELATED_POWERSHELL_LAUNCH');
  const nonce=process.env.RF_V6_LAUNCH_NONCE;
  if(typeof nonce!=='string'||!/^[a-f0-9]{32}$/i.test(nonce)||
     typeof last.launchSha256!=='string'||
     !/^[a-f0-9]{64}$/i.test(last.launchSha256))
    throw new Error('FRESH_LAUNCH_PROOF_REQUIRED');
  const hash=createHash('sha256').update(nonce,'utf8').digest();
  if(!timingSafeEqual(hash,Buffer.from(last.launchSha256,'hex')))
    throw new Error('LAUNCH_PROOF_MISMATCH');
}
export async function runApprovedV6({prepared,paths=attemptFiles(),approval,key,
  requestFetch=globalThis.fetch}){
  verifyFreshApproval({approval,key,paths});
  safePrepared(prepared);
  // From this create-new stage onward an ambiguous outcome consumes the ID.
  mkdirSync(dirname(paths.lockPath),{recursive:true,mode:0o700});
  emitStage(paths.nodeStages,'node_started',{create:true});
  let posts=0;
  try{
    emitStage(paths.nodeStages,'preflight_verified');
    emitStage(paths.nodeStages,'lock_request_begin');
    const result=await runSingleAttempt({
      lockPath:paths.lockPath,reportPath:paths.reportPath,
      metadata:prepared.metadata,
      execute:async({markModelRequestStart,recordProviderUsage})=>{
        const reply=await reviewWithAI(prepared.batch,{
          model:V6.model,reasoningEffort:V6.effort,
          reviewContext:prepared.reviewContext,requestKey:key,
          requestTimeoutMs:V6.timeoutMs,
          requestFetch:async(url,options)=>{
            if(++posts!==1 || String(url)!=='https://api.openai.com/v1/responses' ||
               options?.method!=='POST')throw new Error('ONE_POST_ONLY');
            // Fail before network if the source input is not the frozen blind PR5.
            assertBlindedPr5Request(options.body);
            persistRequestManifest(paths.manifestPath,prepared,options.body);
            emitStage(paths.nodeStages,'fetch_invoked');
            return requestFetch(url,options);
          },
          onBeforeRequest:({model,store,reasoningEffort,maxOutputTokens,
            requestBytes})=>{
            if(model!==V6.model||store!==false||reasoningEffort!==V6.effort||
               maxOutputTokens!==V6.maxOutputTokens||
               !Number.isSafeInteger(requestBytes)||
               requestBytes>V6.maxRequestBytes)
              throw new Error('V6_REQUEST_CAP_FAILED');
            emitStage(paths.nodeStages,'fetch_intent_persisted');
            markModelRequestStart();
            emitStage(paths.nodeStages,'dispatch_persisted');
          },
          onProviderReceipt:receipt=>{
            recordProviderUsage(receipt);
            emitStage(paths.nodeStages,'usage_persisted');
          }
        });
        if(reply.diagnostics?.filteredFindings!==0)
          throw new Error('UNVERIFIED_MODEL_SUGGESTIONS');
        return reply;
      }
    });
    emitStage(paths.nodeStages,'report_persisted');
    return {attempt:V6.id,status:result.status,
      modelAttemptCount:result.modelAttemptCount,
      providerUsage:result.providerUsage?{
        httpStatus:result.providerUsage.httpStatus,
        inputTokens:result.providerUsage.inputTokens,
        outputTokens:result.providerUsage.outputTokens
      }:null,githubWrites:0,
      quality:'NOT_INDEPENDENTLY_SCORED'};
  }catch{
    try{emitStage(paths.nodeStages,'failed_unverified');}catch{}
    throw new Error('V6_UNVERIFIED_INSPECT_JOURNAL_DO_NOT_RETRY');
  }
}
export async function preflightV6(target){
  assertCleanExecutingEngine();
  const result=await preflightPr5(target);
  return {...result,attempt:V6.id,note:'Future stable journal not created'};
}
async function main(){
  const [mode,target]=process.argv.slice(2);
  if(!['--preflight','--execute-paid'].includes(mode)||!target)
    throw new Error('EXPLICIT_PREFLIGHT_OR_PAID_MODE_REQUIRED');
  const engine=assertCleanExecutingEngine();
  if(mode==='--preflight'){
    if(process.env.RF_V6_PINNED_ENGINE && process.env.RF_V6_PINNED_ENGINE!==engine)
      throw new Error('ENGINE_COMMIT_CHANGED');
    process.stdout.write(JSON.stringify(await preflightV6(target),null,2)+'\n');
    return;
  }
  if(process.env.RF_V6_PINNED_ENGINE!==engine)
    throw new Error('PINNED_ENGINE_APPROVAL_REQUIRED');
  if(process.env.RF_APPROVED_PAID_ATTEMPT!==V6.id)
    throw new Error('FRESH_V6_APPROVAL_REQUIRED');
  const prepared=await preparePr5(target,engine,{allowTestKey:true});
  const result=await runApprovedV6({prepared,
    approval:process.env.RF_APPROVED_PAID_ATTEMPT,
    key:process.env.OPENAI_TEST_API_KEY});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(()=>{
    process.stderr.write('V6_NOT_VERIFIED; consult private stage markers; NEVER RETRY\n');
    process.exitCode=1;
  });
}
