import {Buffer} from 'node:buffer';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {userInfo,tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {planReviewBatches,reviewWithAI,renderReviewContext} from '../src/reviewer.mjs';
import {collectReviewContext} from '../src/review-context.mjs';
import {runSingleAttempt} from './one-shot-journal.mjs';

// Future identity only. This file has no paid mode and never creates this journal.
export const PR5=Object.freeze({
  repository:'ibboabdoli-ai/reviewforge-sandbox',pr:5,
  baseSha:'420bf122458eb298080bca9e94e6fcfb32339e59',
  headSha:'c4054f5e247514c80b76344eb1854e2345aa8037',
  model:'gpt-6.1-sol',futureAttempt:'rf-pr5-audited-once-20261115-v6'
});
export const EXPECTED_PATHS=Object.freeze([
  '.github/workflows/holdout-sample.yml',
  'src/lib/invoice-index.mjs','src/lib/tenant-metrics.mjs',
  'src/services/invoice-preview.mjs','src/services/seat-reservations.mjs',
  'tests/invoice-preview.test.mjs','tests/seat-reservations.test.mjs',
  'tests/tenant-metrics.test.mjs'
]);
const EXPECTED=new Set(EXPECTED_PATHS);
const ENGINE_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const git=(dir,...args)=>execFileSync('git',['-c','safe.directory='+dir,'-C',dir,...args],{
  encoding:'utf8',maxBuffer:5_000_000,stdio:['ignore','pipe','ignore']
});
export const executingEngineSha=()=>git(ENGINE_ROOT,'rev-parse','HEAD').trim();
export const futureJournalRoot=()=>join(userInfo().homedir,'.reviewforge','benchmark-journal');

function noRealCredentials(){
  for(const key of ['OPENAI_API_KEY','OPENAI_TEST_API_KEY',
    'RF_APPROVED_PAID_ATTEMPT','DATABASE_URL','STRIPE_SECRET_KEY',
    'GITHUB_TOKEN','GITHUB_PRIVATE_KEY']){
    if(process.env[key])throw new Error('OFFLINE_ONLY_CREDENTIAL_ENV_FORBIDDEN');
  }
}

export async function preparePr5(targetDir,engineSha=executingEngineSha()){
  noRealCredentials();
  if(!/^[a-f0-9]{40}$/i.test(engineSha))throw new Error('PINNED_ENGINE_REQUIRED');
  const target=resolve(targetDir);
  if(git(target,'rev-parse','HEAD').trim()!==PR5.headSha ||
     git(target,'rev-parse',PR5.baseSha).trim()!==PR5.baseSha ||
     git(target,'status','--porcelain').trim())
    throw new Error('FROZEN_PR5_CHECKOUT_REQUIRED');
  const rows=git(target,'diff','--name-status',PR5.baseSha,PR5.headSha)
    .trim().split(/\r?\n/).filter(Boolean);
  const paths=rows.map(row=>row.split('\t').at(-1));
  if(paths.length!==8 || new Set(paths).size!==8 ||
     paths.some(path=>!EXPECTED.has(path)))
    throw new Error('FROZEN_PR5_CHANGED_FILE_SET_MISMATCH');
  const files=rows.map((row,index)=>{
    const [status]=row.split('\t'),filename=paths[index];
    const diff=git(target,'diff','--no-ext-diff','--no-textconv','--unified=3',
      PR5.baseSha,PR5.headSha,'--',filename);
    const hunk=diff.search(/^@@ /m);
    return {filename,status:status==='A'?'added':status==='D'?'removed':'modified',
      patch:hunk<0?null:diff.slice(hunk)};
  });
  const selected=planReviewBatches(files,{maxBatches:1,maxBatchCharacters:24000});
  if(!selected.coverage.complete || selected.coverage.totalChanged!==8 ||
     selected.coverage.reviewable!==8 || selected.coverage.reviewed!==8 ||
     selected.batches.length!==1 ||
     new Set(selected.batches[0].map(f=>f.filename)).size!==8)
    throw new Error('FROZEN_PR5_COVERAGE_INCOMPLETE');

  // The only supplemental source this preflight can read is from the eight
  // frozen changed files. In particular, it cannot load benchmark gold or
  // any CodeRabbit discussion from the engine repository.
  let pinnedReads=0;
  const prefix='/repos/'+PR5.repository+'/contents/';
  const api=async(path,token)=>{
    const [url,sha]=path.split('?ref=');
    if(token!=='PR5_PINNED_LOCAL_ONLY'||!url.startsWith(prefix)||sha!==PR5.headSha)
      throw new Error('UNPINNED_SOURCE_READ_REFUSED');
    const filename=decodeURIComponent(url.slice(prefix.length));
    if(!EXPECTED.has(filename))throw new Error('GitHub 404: Not Found');
    pinnedReads++;
    const body=git(target,'show',PR5.headSha+':'+filename);
    return {type:'file',size:Buffer.byteLength(body),encoding:'base64',
      content:Buffer.from(body).toString('base64')};
  };
  const reviewContext=await collectReviewContext({repository:PR5.repository,
    sha:PR5.headSha,files:selected.batches[0],api,token:'PR5_PINNED_LOCAL_ONLY'});
  const transmittedContextChars=renderReviewContext(reviewContext).length;
  if(reviewContext.headSha!==PR5.headSha ||
     reviewContext.totalChars>12000 || transmittedContextChars>12000 ||
     reviewContext.projectRules ||
     reviewContext.snippets.some(s=>!EXPECTED.has(s.path)))
    throw new Error('FROZEN_PR5_CONTEXT_UNTRUSTED');
  return {files,batch:selected.batches[0],coverage:selected.coverage,
    reviewContext,pinnedReads,transmittedContextChars,
    metadata:{repository:PR5.repository,pr:PR5.pr,headSha:PR5.headSha,
      engineSha,model:PR5.model}};
}

function requireDisposableJournal(dir){
  const full=resolve(dir),temp=resolve(tmpdir());
  if(dirname(full)!==temp || !/^rf-pr5-offline-[a-z0-9-]+$/i.test(basename(full)) ||
     !existsSync(full))throw new Error('OFFLINE_DISPOSABLE_JOURNAL_REQUIRED');
  return full;
}

const syntheticResult=(summary,findings=[])=>({
  status:'completed',output_text:JSON.stringify({summary,findings}),
  usage:{input_tokens:17,output_tokens:9}
});
function syntheticResponse(scenario){
  if(scenario==='http-503')return new Response(JSON.stringify({error:{message:'synthetic'}}),{status:503});
  if(scenario==='bad-json')return new Response('not json',{status:200});
  if(scenario==='timeout')throw new DOMException('Synthetic timeout','TimeoutError');
  if(scenario==='unanchored')return Response.json(syntheticResult('Synthetic, unanchored',[
    {path:'src/services/invoice-preview.mjs',line:99999,severity:'high',
      category:'test',title:'Synthetic invalid anchor',
      body:'This is a deliberately invalid synthetic suggestion.',confidence:0.99}
  ]));
  if(scenario==='secret'){
    const marker='sk-proj-SYNTHETICPR5TOKEN123456789';
    return Response.json(syntheticResult('Synthetic '+marker,[
      {path:'src/services/invoice-preview.mjs',line:1,severity:'low',
        category:'test',title:'Synthetic '+marker,
        body:'Synthetic credential redaction probe '+marker,confidence:0.99}
    ]));
  }
  if(scenario==='success')return Response.json(syntheticResult('Offline mock only; no AI review'));
  throw new Error('UNKNOWN_OFFLINE_SCENARIO');
}

export async function runMockPr5(prepared,journalDir,{scenario='success',
  maxRequestBytes=50000}={}){
  noRealCredentials();
  if(!['success','http-503','bad-json','timeout','unanchored','secret'].includes(scenario))
    throw new Error('UNKNOWN_OFFLINE_SCENARIO');
  if(!Number.isSafeInteger(maxRequestBytes)||maxRequestBytes<1||maxRequestBytes>50000)
    throw new Error('OFFLINE_REQUEST_CAP_INVALID');
  if(prepared?.metadata?.repository!==PR5.repository ||
     prepared.metadata.pr!==PR5.pr || prepared.metadata.headSha!==PR5.headSha ||
     prepared.metadata.model!==PR5.model ||
     prepared.coverage?.complete!==true || prepared.coverage.reviewed!==8 ||
     prepared.batch?.length!==8)
    throw new Error('FROZEN_PR5_PREPARED_IDENTITY_REQUIRED');
  const root=requireDisposableJournal(journalDir);
  const lockPath=join(root,'attempt.lock'),reportPath=join(root,'result.json');
  let syntheticRequests=0,requestBytes=0;
  const report=await runSingleAttempt({lockPath,reportPath,
    metadata:prepared.metadata,execute:async({markModelRequestStart,recordProviderUsage})=>{
      const reply=await reviewWithAI(prepared.batch,{
        model:PR5.model,reasoningEffort:'high',reviewContext:prepared.reviewContext,
        requestKey:'sk-LOCAL-SYNTHETIC-NOT-A-CREDENTIAL',
        requestFetch:async(url,options)=>{
          if(++syntheticRequests!==1 || String(url)!=='https://api.openai.com/v1/responses' ||
             options?.method!=='POST')throw new Error('OFFLINE_ONE_SYNTHETIC_POST_ONLY');
          const payload=JSON.parse(options.body);
          if(!EXPECTED_PATHS.every(path=>payload.input.includes('FILE: '+path+'\nDIFF:')) ||
             /heldout-20261107-pr5-gold|verify-heldout-pr5|benchmarks\/|coderabbit.*finding/i
               .test(options.body))
            throw new Error('OFFLINE_INPUT_IS_NOT_BLINDED');
          return syntheticResponse(scenario);
        },
        onBeforeRequest:({model,store,reasoningEffort,maxOutputTokens,
          requestBytes:bytes})=>{
          requestBytes=bytes;
          if(model!==PR5.model||store!==false||reasoningEffort!=='high'||
             maxOutputTokens!==6000||!Number.isSafeInteger(bytes)||
             bytes>maxRequestBytes)throw new Error('OFFLINE_REQUEST_CAP_FAILED');
          markModelRequestStart();
        },onProviderReceipt:recordProviderUsage
      });
      if(reply.diagnostics?.filteredFindings!==0)
        throw new Error('UNVERIFIED_SYNTHETIC_SUGGESTION');
      return reply;
    }
  });
  return {report,syntheticRequests,requestBytes};
}

export async function preflightPr5(targetDir){
  const prepared=await preparePr5(targetDir);
  const root=mkdtempSync(join(tmpdir(),'rf-pr5-offline-'));
  try{
    const {report,syntheticRequests,requestBytes}=await runMockPr5(prepared,root);
    if(report.status!=='completed'||report.modelAttemptCount!==1||
       report.githubWrites!==0||report.independentQualityMeasured!==false||
       syntheticRequests!==1)throw new Error('OFFLINE_PREFLIGHT_FAILED');
    return {mode:'OFFLINE_MOCK_ONLY',engineSha:prepared.metadata.engineSha,
      targetHead:PR5.headSha,targetBase:PR5.baseSha,
      futureAttempt:PR5.futureAttempt,coverage:prepared.coverage,
      pinnedReads:prepared.pinnedReads,
      contextChars:prepared.transmittedContextChars,requestBytes,
      syntheticRequests,realProviderRequests:0,githubWrites:0,
      journal:'disposable OS temp directory; future stable journal untouched',
      quality:'NOT_MEASURED'};
  }finally{rmSync(root,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  preflightPr5(process.argv[2]).then(result=>{
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }).catch(()=>{
    process.stderr.write('PR5_OFFLINE_PREFLIGHT_FAILED; no paid request was attempted\n');
    process.exitCode=1;
  });
}
