import {execFileSync} from 'node:child_process';
import {Buffer} from 'node:buffer';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {planReviewBatches,reviewWithAI} from '../src/reviewer.mjs';
import {collectReviewContext} from '../src/review-context.mjs';
import {verifyFrozenBatch,FROZEN_PR7,runOfflineJournaledReview} from './offline-journaled-review.mjs';
import {runSingleAttempt} from './one-shot-journal.mjs';

// Independent one-shot experiment. No Gold Evidence is imported or read.
export const TRIAL=Object.freeze({
  id:'rf-pr7-independent-once-20261110-v2',
  head:'a628945d7533c7418aed344ed5f90a9a2ec8bc46',
  base:'420bf122458eb298080bca9e94e6fcfb32339e59',
  model:'gpt-6.1-sol',effort:'high',maxOutputTokens:6000,
  maxContextChars:12000,maxRequestBytes:50000,
  timeoutMs:180000,planningBudgetUsd:0.20
});
const oldLock='rf-heldout-pr7-paid-once-20261109.lock';
const newStem='rf-pr7-independent-once-20261110-v2';
export const trialPaths=(root=tmpdir())=>({
  oldLockPath:join(root,oldLock),lockPath:join(root,newStem+'.lock'),
  reportPath:join(root,newStem+'.result.json')
});
const git=(target,...args)=>execFileSync('git',['-C',target,...args],{
  encoding:'utf8',maxBuffer:5000000,stdio:['ignore','pipe','ignore']});
export function checkEnvironment(){
  for(const key of ['OPENAI_API_KEY','DATABASE_URL','STRIPE_SECRET_KEY',
    'GITHUB_TOKEN','GITHUB_PRIVATE_KEY'])if(process.env[key])
      throw new Error('PRODUCTION_CREDENTIAL_ENV_FORBIDDEN');
}
export async function prepareTrial(dir,engineSha){
  if(!dir||!/^[a-f0-9]{40}$/i.test(engineSha??''))
    throw new Error('PINNED_ENGINE_REQUIRED');
  const target=resolve(dir);
  if(git(target,'rev-parse','HEAD').trim()!==TRIAL.head)
    throw new Error('FROZEN_PR7_HEAD_CHANGED');
  if(git(target,'rev-parse',TRIAL.base).trim()!==TRIAL.base)
    throw new Error('FROZEN_PR7_BASE_NOT_PRESENT');
  const rows=git(target,'diff','--name-status',TRIAL.base,TRIAL.head)
    .trim().split(/\r?\n/).filter(Boolean);
  const files=rows.map(row=>{
    const [status,...paths]=row.split('\t'),filename=paths.at(-1);
    const diff=git(target,'diff','--no-ext-diff','--no-textconv','--unified=3',
      TRIAL.base,TRIAL.head,'--',filename);
    const start=diff.search(/^@@ /m);
    return {filename,status:status==='A'?'added':status==='D'?'removed':'modified',
      patch:start>=0?diff.slice(start):null};
  });
  const plan=planReviewBatches(files,{maxBatches:1,maxBatchCharacters:24000});
  if(!plan.coverage.complete||plan.coverage.reviewed!==15||
      plan.batches.length!==1)throw new Error('PR7_INCOMPLETE_COVERAGE');
  let pinnedReads=0;
  const prefix='/repos/'+FROZEN_PR7.repository+'/contents/';
  const api=async(path,token)=>{
    const [url,sha]=path.split('?ref=');
    if(token!=='PINNED_LOCAL_ONLY'||!url.startsWith(prefix)||sha!==TRIAL.head)
      throw new Error('UNPINNED_READ_REFUSED');
    pinnedReads++;
    try{
      const body=git(target,'show',TRIAL.head+':'+decodeURIComponent(url.slice(prefix.length)));
      return {type:'file',size:Buffer.byteLength(body),encoding:'base64',
        content:Buffer.from(body).toString('base64')};
    }catch{throw new Error('GitHub 404: Not Found');}
  };
  const reviewContext=await collectReviewContext({repository:FROZEN_PR7.repository,
    sha:TRIAL.head,files:plan.batches[0],api,token:'PINNED_LOCAL_ONLY'});
  const metadata={repository:FROZEN_PR7.repository,pr:7,
    headSha:TRIAL.head,engineSha,model:TRIAL.model};
  const batch=verifyFrozenBatch({files,reviewContext,metadata});
  if(batch.length!==15||reviewContext.totalChars>TRIAL.maxContextChars)
    throw new Error('PR7_CONTEXT_INCOMPLETE');
  return {files,batch,reviewContext,metadata,coverage:plan.coverage,pinnedReads};
}
export function calculateCost(usage){
  const a=usage?.inputTokens,b=usage?.outputTokens;
  return Number.isSafeInteger(a)&&a>=0&&Number.isSafeInteger(b)&&b>=0
    ?(a*2+b*10)/1000000:null;
}
// Fixed experiment name cannot be changed via a CLI argument.
export function verifyAuthorization({approval,key,paths}){
  if(approval!==TRIAL.id)throw new Error('FRESH_PAID_APPROVAL_REQUIRED');
  if(typeof key!=='string'||!/^sk-(?:proj-)?[A-Za-z0-9_-]{15,}$/.test(key))
    throw new Error('TEST_API_KEY_REQUIRED');
  const expected=trialPaths();
  if(paths?.lockPath!==expected.lockPath||paths?.reportPath!==expected.reportPath)
    throw new Error('FIXED_ONE_SHOT_LOCK_PATH_REQUIRED');
  if(existsSync(paths.lockPath)||existsSync(paths.reportPath)||
      existsSync(paths.reportPath+'.usage.json'))
    throw new Error('ONE_SHOT_ATTEMPT_ALREADY_USED');
}
export async function runApprovedOnce({prepared,paths,approval,key,
  fetchOnce=globalThis.fetch}){
  checkEnvironment();
  verifyAuthorization({approval,key,paths});
  if(prepared?.metadata?.headSha!==TRIAL.head||
      prepared?.metadata?.model!==TRIAL.model||
      prepared?.coverage?.reviewed!==15||!prepared?.coverage?.complete)
    throw new Error('PREPARED_TRIAL_MISMATCH');
  let posts=0;
  const guardedFetch=async(url,options)=>{
    if(++posts!==1||String(url)!=='https://api.openai.com/v1/responses'||
        options?.method!=='POST')throw new Error('SECOND_POST_REFUSED');
    return fetchOnce(url,options);
  };
  const result=await runSingleAttempt({metadata:prepared.metadata,
    lockPath:paths.lockPath,reportPath:paths.reportPath,
    execute:async({markModelRequestStart,recordProviderUsage})=>
      reviewWithAI(prepared.batch,{model:TRIAL.model,reasoningEffort:TRIAL.effort,
        reviewContext:prepared.reviewContext,requestKey:key,
        requestTimeoutMs:TRIAL.timeoutMs,requestFetch:guardedFetch,
        onBeforeRequest:({model,store,maxOutputTokens,reasoningEffort,requestBytes})=>{
          if(model!==TRIAL.model||store!==false||
              maxOutputTokens!==TRIAL.maxOutputTokens||
              reasoningEffort!==TRIAL.effort||
              !Number.isSafeInteger(requestBytes)||requestBytes>TRIAL.maxRequestBytes)
            throw new Error('MODEL_REQUEST_CAP_REFUSED');
          markModelRequestStart();
        },onProviderReceipt:recordProviderUsage
      })
  });
  return {status:result.status,attempt:TRIAL.id,providerUsage:result.providerUsage,
    estimatedUsd:calculateCost(result.providerUsage),findings:result.findings,
    quality:'UNSCORED',githubWrites:0};
}
export async function preflightOnly(prepared){
  checkEnvironment();
  if(process.env.OPENAI_TEST_API_KEY)throw new Error('TEST_KEY_NOT_ALLOWED_IN_PREFLIGHT');
  const root=mkdtempSync(join(tmpdir(),'rf-pr7-free-preflight-'));
  try{
    const response=await runOfflineJournaledReview({files:prepared.files,
      reviewContext:prepared.reviewContext,metadata:prepared.metadata,
      lockPath:join(root,'attempt.lock'),reportPath:join(root,'result.json'),
      mockOutcome:JSON.stringify({kind:'response',
        body:{status:'completed',output_text:JSON.stringify({
          summary:'Offline synthetic; NOT real AI output',findings:[]}),
          usage:{input_tokens:12,output_tokens:5}}})});
    if(response.status!=='completed'||response.independentQualityMeasured!==false||
        response.githubWrites!==0)throw new Error('OFFLINE_PREFLIGHT_FAILED');
    return {head:prepared.metadata.headSha,engine:prepared.metadata.engineSha,
      coverage:prepared.coverage,contextChars:prepared.reviewContext.totalChars,
      pinnedReads:prepared.pinnedReads,networkCalls:0,modelCalls:0,
      oldLockUntouched:true,plannedUsd:TRIAL.planningBudgetUsd};
  }finally{rmSync(root,{recursive:true,force:true});}
}
async function main(){
  const [mode,dir]=process.argv.slice(2);
  if(!['--preflight','--execute-paid'].includes(mode)||!dir)
    throw new Error('USAGE_PREFLIGHT_OR_EXPLICIT_PAID');
  checkEnvironment();
  const engine=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const prepared=await prepareTrial(dir,engine);
  if(mode==='--preflight'){
    process.stdout.write(JSON.stringify(await preflightOnly(prepared),null,2)+'\n');return;
  }
  const result=await runApprovedOnce({prepared,paths:trialPaths(),
    approval:process.env.RF_APPROVED_PAID_ATTEMPT,
    key:process.env.OPENAI_TEST_API_KEY});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  main().catch(()=>{
    // Never echo provider exception, API key, input patch or raw response.
    process.stderr.write('RUN_NOT_VERIFIED: Inspect isolated journal; do not retry.\n');
    process.exitCode=1;
  });
}
