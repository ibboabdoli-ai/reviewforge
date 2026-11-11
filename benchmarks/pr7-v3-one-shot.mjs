// New, independent one-shot PR7 attempt; NEVER automatically replay old ids.
// Default mode is OFFLINE preflight. Paid path needs a separate user approval.
import {existsSync,mkdirSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {prepareTrial,preflightOnly,stableJournalRoot,TRIAL,calculateCost,checkEnvironment}
  from './pr7-one-paid.mjs';
import {runSingleAttempt} from './one-shot-journal.mjs';
import {reviewWithAI} from '../src/reviewer.mjs';

export const NEW_ATTEMPT_ID='rf-pr7-audited-once-20261111-v3';
const APPROVED_STAGES=new Set([
  'node_started','preflight_verified','lock_request_begin','fetch_intent_persisted',
  'dispatch_persisted','fetch_invoked','usage_persisted','report_persisted','failed_unverified'
]);
export function attemptFiles(root=stableJournalRoot()){
  return Object.freeze({
    lockPath:join(root,NEW_ATTEMPT_ID+'.lock'),
    reportPath:join(root,NEW_ATTEMPT_ID+'.result.json'),
    nodeStages:join(root,NEW_ATTEMPT_ID+'.node-stages.jsonl'),
    shellStages:join(root,NEW_ATTEMPT_ID+'.shell-stages.jsonl')
  });
}
export function assertNewAttemptUnused(paths=attemptFiles()){
  const fixed=attemptFiles();
  if(paths.lockPath!==fixed.lockPath || paths.reportPath!==fixed.reportPath ||
     paths.nodeStages!==fixed.nodeStages || paths.shellStages!==fixed.shellStages)
    throw new Error('NEW_ATTEMPT_FIXED_OS_ACCOUNT_PATH_REQUIRED');
  if([paths.lockPath,paths.reportPath,paths.reportPath+'.usage.json',
      paths.reportPath+'.dispatch.json',paths.nodeStages].some(existsSync))
    throw new Error('NEW_ATTEMPT_ALREADY_HAS_EVIDENCE_DO_NOT_RETRY');
}
// Minimal, whitelisted and flushed tracing. No provider text, secrets, paths,
// command lines, token values or arbitrary error messages are persisted.
function emitPhase(path,stage,{create=false}={}){
  if(!APPROVED_STAGES.has(stage))throw new Error('INVALID_SAFE_STAGE');
  const item=JSON.stringify({
    attempt:NEW_ATTEMPT_ID,stage,utc:new Date().toISOString(),schema:1
  })+'\n';
  if(create)writeFileSync(path,item,{flag:'wx',mode:0o600,flush:true});
  else appendFileSync(path,item,{flag:'a',mode:0o600,flush:true});
}
export function getStageNames(path){
  if(!existsSync(path))return [];
  // Diagnostic reading is useful, but stage names do not establish billing.
  const contents=readFileSync(path,'utf8');
  return contents.split(/\r?\n/).filter(Boolean).map(line=>{
    const o=JSON.parse(line);
    if(o.attempt!==NEW_ATTEMPT_ID||!APPROVED_STAGES.has(o.stage))
      throw new Error('UNTRUSTED_TRACE_EVIDENCE');
    return o.stage;
  });
}
function safePrepared(prepared){
  if(prepared?.metadata?.headSha!==TRIAL.head ||
     prepared.metadata?.model!==TRIAL.model ||
     prepared.metadata?.repository!=='ibboabdoli-ai/reviewforge-sandbox' ||
     prepared.metadata?.pr!==7 ||
     !/^[a-f0-9]{40}$/i.test(prepared.metadata?.engineSha??'') ||
     prepared.coverage?.reviewed!==15 || prepared.coverage?.complete!==true ||
     prepared.coverage?.batches!==1 || prepared.batch?.length!==15)
    throw new Error('FROZEN_PR7_SOURCE_PREFLIGHT_REQUIRED');
}
export function verifyOneShotApproval({approval,key,paths}){
  checkEnvironment();
  if(approval!==NEW_ATTEMPT_ID)throw new Error('NEW_PAID_APPROVAL_REQUIRED');
  if(typeof key!=='string'||!/^sk-(?:proj-)?[A-Za-z0-9_-]{15,}$/.test(key))
    throw new Error('PRIVATE_TEST_KEY_REQUIRED');
  assertNewAttemptUnused(paths);
  // The only allowed source is the independently approved PowerShell wrapper.
  if(!existsSync(paths.shellStages))throw new Error('POWERSHELL_STAGE_REQUIRED');
  const text=readFileSync(paths.shellStages,'utf8');
  if(!text.includes('"stage":"node_launching"') ||
     !text.includes('"attempt":"'+NEW_ATTEMPT_ID+'"'))
    throw new Error('POWERSHELL_LAUNCH_EVIDENCE_REQUIRED');
}
export async function runApprovedV3({
  prepared,paths=attemptFiles(),approval,key,requestFetch=globalThis.fetch
}){
  verifyOneShotApproval({approval,key,paths});
  safePrepared(prepared);
  // Any failure from this point is permanently non-retryable for this ID.
  mkdirSync(dirname(paths.lockPath),{recursive:true,mode:0o700});
  emitPhase(paths.nodeStages,'node_started',{create:true});
  let posts=0;
  let providerSeen=false;
  try {
    emitPhase(paths.nodeStages,'preflight_verified');
    emitPhase(paths.nodeStages,'lock_request_begin');
    const result=await runSingleAttempt({
      lockPath:paths.lockPath,reportPath:paths.reportPath,metadata:prepared.metadata,
      execute:async({markModelRequestStart,recordProviderUsage})=>{
        const reply=await reviewWithAI(prepared.batch,{
          model:TRIAL.model,reasoningEffort:TRIAL.effort,reviewContext:prepared.reviewContext,
          requestKey:key,requestTimeoutMs:TRIAL.timeoutMs,
          requestFetch:async(url,options)=>{
            if(++posts!==1 || String(url)!=='https://api.openai.com/v1/responses' ||
                options?.method!=='POST')
              throw new Error('MAX_ONE_PROVIDER_POST');
            // This proves only local pre-fetch intent, not provider receipt.
            emitPhase(paths.nodeStages,'fetch_invoked');
            return requestFetch(url,options);
          },
          onBeforeRequest:({model,store,reasoningEffort,maxOutputTokens,requestBytes})=>{
            if(model!==TRIAL.model||store!==false||reasoningEffort!==TRIAL.effort||
                maxOutputTokens!==TRIAL.maxOutputTokens||
                !Number.isSafeInteger(requestBytes)||requestBytes>TRIAL.maxRequestBytes)
              throw new Error('PROVIDER_BUDGET_PRECHECK_FAILED');
            emitPhase(paths.nodeStages,'fetch_intent_persisted');
            markModelRequestStart();
            emitPhase(paths.nodeStages,'dispatch_persisted');
          },
          onProviderReceipt:(receipt)=>{
            // After HTTP: a narrow atomically published receipt contains only
            // status, request id and usage numbers; not raw response or key.
            recordProviderUsage(receipt);
            providerSeen=true;
            emitPhase(paths.nodeStages,'usage_persisted');
          }
        });
        if(reply.diagnostics?.filteredFindings!==0)
          throw new Error('UNVERIFIED_MODEL_SUGGESTIONS');
        return reply;
      }
    });
    emitPhase(paths.nodeStages,'report_persisted');
    return {
      attempt:NEW_ATTEMPT_ID,status:result.status,
      estimatedUsd:calculateCost(result.providerUsage),
      modelAttemptCount:result.modelAttemptCount,
      providerUsage:result.providerUsage,
      quality:'NOT_GOLD_SCORED',githubWrites:0
    };
  }catch{
    // If storage itself failed, this final stage may fail as well. Preserve
    // any earlier stage, lock and receipts. NEVER delete or rerun on failure.
    try{emitPhase(paths.nodeStages,'failed_unverified');}catch{}
    const err=new Error('ONE_SHOT_UNVERIFIED_INSPECT_JOURNAL_DO_NOT_RETRY');
    err.code='ONE_SHOT_UNVERIFIED';
    throw err;
  }
}
export async function preflightV3(prepared){
  checkEnvironment();
  if(process.env.OPENAI_TEST_API_KEY||process.env.RF_APPROVED_PAID_ATTEMPT)
    throw new Error('NO_KEYS_OR_APPROVAL_IN_OFFLINE_PREFLIGHT');
  safePrepared(prepared);
  const report=await preflightOnly(prepared);
  return {
    attempt:NEW_ATTEMPT_ID,mode:'OFFLINE_ONLY',target:report.head,
    engine:report.engine,coverage:report.coverage,
    contextChars:report.contextChars,providerCalls:0,
    note:'No attempt lock or shell stage was created'
  };
}
async function main(){
  const args=process.argv.slice(2);
  const mode=args[0],target=args[1];
  if(!['--preflight','--execute-paid'].includes(mode)||!target)
    throw new Error('USE_EXPLICIT_OFFLINE_PREFLIGHT');
  const engine=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  if(process.env.RF_V3_PINNED_ENGINE &&
      process.env.RF_V3_PINNED_ENGINE!==engine)
    throw new Error('ENGINE_COMMIT_CHANGED');
  const prepared=await prepareTrial(target,engine);
  if(mode==='--preflight'){
    const report=await preflightV3(prepared);
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
    return;
  }
  if(process.env.RF_V3_PINNED_ENGINE!==engine)
    throw new Error('PINNED_ENGINE_APPROVAL_REQUIRED');
  const summary=await runApprovedV3({
    prepared,approval:process.env.RF_APPROVED_PAID_ATTEMPT,
    key:process.env.OPENAI_TEST_API_KEY
  });
  // Only numerical usage and fixed identifiers, no raw model text.
  process.stdout.write(JSON.stringify(summary,null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(()=>{
    // Never echo raw exceptions, user code, request bodies or secrets.
    process.stderr.write('V3_NOT_VERIFIED; consult private stage markers; NEVER RETRY THIS ID\n');
    process.exitCode=1;
  });
}
