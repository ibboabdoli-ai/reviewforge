import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { githubApi, installationToken, changedFiles, postReview } from './github.mjs';
import { planReviewBatches, coverageSummary, validateFindings, unverifiedModelSuggestions, reviewWithAI } from './reviewer.mjs';
import { repositoryAllowed } from './review-policy.mjs';
import { selectReviewModel } from './model-router.mjs';
import { collectReviewContext } from './review-context.mjs';

/**
 * One paid model batch per invocation, with a durable checkpoint between calls.
 * The checkpoint stores only a digest and validated findings, never PR patches.
 * Expired model invocations are terminal: no automatic replay of paid requests.
 */
export async function analyzePullRequestStep({
  reviewId, repository, number, headSha, installationId,
  postMode=config.reviewPostMode, allowDraft=false
}, deps={}) {
  if(!Number.isSafeInteger(Number(reviewId)) || Number(reviewId)<=0 ||
     !/^[\w.-]+\/[\w.-]+$/.test(repository) ||
     !Number.isSafeInteger(number) || number<=0 ||
     !/^[0-9a-f]{40}$/i.test(headSha) ||
     !Number.isSafeInteger(Number(installationId)) ||
     !['dry-run','live','fallback'].includes(postMode) ||
     (allowDraft && postMode!=='dry-run')) throw new Error('Invalid incremental review target');

  for(const key of ['loadProgress','initProgress','saveProgress']) {
    if(typeof deps[key]!=='function') throw new Error('Durable review checkpoint is unavailable');
  }

  const api=deps.githubApi || githubApi;
  const token=await (deps.installationToken || installationToken)(installationId);
  const pullPath='/repos/'+repository+'/pulls/'+number;
  const initial=await api(pullPath,token);
  if(initial.head?.sha!==headSha) return {
    status:'superseded',summary:'PR HEAD changed before review; no comments posted.',
    findings:[],posted:0
  };
  if(initial.state!=='open' || (initial.draft && !allowDraft)) return {
    status:'skipped',summary:'PR is closed or draft without an authorized shadow request.',
    findings:[],posted:0
  };

  const files=await (deps.changedFiles || changedFiles)({
    repoFullName:repository,prNumber:number,token
  });
  // Keep individual LLM calls modest enough for Vercel's 120s maximum.
  // The legacy all-at-once pipeline retains its previous batch size.
  const {batches,coverage}=planReviewBatches(files,{maxBatchCharacters:24000});
  // Fail closed on incomplete diffs before optional SHA-pinned file reads.
  // Avoid unnecessary GitHub API calls; never reserve or spend paid AI work.
  if(!coverage.complete || !batches.length) {
    // Changed-file data is not SHA-pinned by GitHub's PR/files endpoint.
    // Even an unpaid incomplete verdict must not be assigned to an old HEAD.
    const current=await api(pullPath,token);
    if(current.head?.sha!==headSha || current.state!=='open' ||
       (current.draft && !allowDraft)) return {
      status:'superseded',posted:0,findings:[],
      summary:'PR HEAD or state changed during incomplete-diff preflight; no AI calls made.'
    };
    return {
      status:'partial',posted:0,findings:[],coverage,
      summary:coverageSummary(coverage)+' Review incomplete; no AI calls made.'
    };
  }

  const useContext=repositoryAllowed(repository,config.aiContextRepositories);
  // For staged reviews, compute every input before the first paid attempt.
  const reviewContext=useContext
    ? await (deps.collectReviewContext || collectReviewContext)({
        repository,sha:headSha,files,token,api
      })
    : null;
  // The PR may advance while its changed-file list and optional SHA-pinned
  // context are being fetched. Never reserve quota or call a paid model for
  // a HEAD already superseded before the next batch starts.
  const beforePaid=await api(pullPath,token);
  if(beforePaid.head?.sha!==headSha || beforePaid.state!=='open' ||
     (beforePaid.draft && !allowDraft)) return {
    status:'superseded',posted:0,findings:[],coverage,
    summary:'PR HEAD or state changed before paid review; no AI calls made.'
  };
  // Model selection must consider the entire PR, not only the current batch.
  const modelChoice=repositoryAllowed(repository,config.aiAutoModelRepositories)
    ?selectReviewModel(batches.flat(),{fastModel:config.openai.modelFast,deepModel:config.openai.modelDeep,
      enhancedRisk:useContext})
    :null;
  const planHash=createHash('sha256').update(JSON.stringify({
    headSha,postMode,allowDraft,batches,coverage,reviewContext,
    modelPolicy:{
      auto:repositoryAllowed(repository,config.aiAutoModelRepositories),
      defaultModel:config.openai.model,
      fastModel:config.openai.modelFast,
      deepModel:config.openai.modelDeep
    }
  })).digest('hex');
  let progress=await deps.loadProgress(reviewId);
  let results=[];
  let next=0;
  if(progress){
    if(progress.plan_hash!==planHash ||
       Number(progress.total_batches)!==batches.length) return {
      status:'superseded',posted:0,findings:[],coverage,
      summary:'The PR diff or review policy changed during a staged review; previous batch results were discarded.'
    };
    next=Number(progress.completed_batches);
    try{results=JSON.parse(progress.results_json)}catch{results=null}
    if(!Number.isSafeInteger(next)||next<0||next>batches.length||
       !Array.isArray(results)||results.length!==next||
       results.some(r=>!r||typeof r.summary!=='string'||!Array.isArray(r.findings))){
      const error=new Error('Invalid persisted review checkpoint; paid work will not be replayed.');
      error.nonRetryable=true;throw error;
    }
  }else{
    if(deps.reserveModelCalls){
      const reservation=await deps.reserveModelCalls(batches.length);
      if(reservation!==true && reservation?.allowed!==true){
        const insufficient=reservation?.reason==='requires-higher-cap';
        return {status:insufficient?'partial':'deferred',posted:0,findings:[],coverage,
          summary:insufficient
            ? 'The review needs '+batches.length+' model batches, exceeding the daily quota; no calls made.'
            : 'AI daily allowance exhausted; no calls made. Review deferred until the next UTC day.'};
      }
    }
    // Quota reservation awaits storage; the pull request can move while
    // awaiting it. Avoid creating a checkpoint or paying for a stale SHA.
    const afterReservation=await api(pullPath,token);
    if(afterReservation.head?.sha!==headSha || afterReservation.state!=='open' ||
       (afterReservation.draft && !allowDraft)) return {
      status:'superseded',posted:0,findings:[],coverage,
      summary:'PR changed during quota reservation; no model calls made.'
    };
    const inserted=await deps.initProgress({
      reviewId,planHash,totalBatches:batches.length
    });
    if(inserted!==true){
      const error=new Error('Could not establish an exclusive checkpoint; model call blocked.');
      error.nonRetryable=true;throw error;
    }
  }

  if(next<batches.length){
    // Checkpoint reads/writes also await storage and can outlast a PR HEAD.
    // A final no-cost state check is needed immediately before each model batch.
    const beforeModel=await api(pullPath,token);
    if(beforeModel.head?.sha!==headSha || beforeModel.state!=='open' ||
       (beforeModel.draft && !allowDraft)) return {
      status:'superseded',posted:0,findings:[],coverage,
      summary:'PR changed during checkpoint operations; no model calls made.'
    };
    const batch=batches[next];
    const choice=modelChoice;
    const options={batchIndex:next+1,totalBatches:batches.length,
      ...(reviewContext?{reviewContext}:{}) ,
      ...(choice?{model:choice.model,reasoningEffort:choice.effort,modelTier:choice.tier}:{})};
    deps.onModelStart?.();
    let response;
    try{response=await (deps.reviewWithAI || reviewWithAI)(batch,options);}
    catch(error){error.nonRetryable=true;throw error;}
    const accepted=validateFindings(response.findings,batch);
    const stats=response.diagnostics;
    const item={
      summary:'Batch '+(next+1)+'/'+batches.length+(choice?' ['+choice.model+']':'')+': '+String(response.summary||'').slice(0,350),
      findings:accepted,
      // Integer counts help diagnose false negatives without retaining raw
      // model output or unvalidated potentially sensitive suggestions.
      diagnostics:stats&&[stats.modelSuggestions,stats.acceptedFindings,stats.filteredFindings].every(
        n=>Number.isSafeInteger(n)&&n>=0&&n<=1000)
        ?{modelSuggestions:stats.modelSuggestions,
          acceptedFindings:stats.acceptedFindings,filteredFindings:stats.filteredFindings}
        :null,
      unverifiedSuggestions:unverifiedModelSuggestions(response,accepted)
    };
    results=[...results,item];
    const saved=await deps.saveProgress({
      reviewId,planHash,previousBatches:next,completedBatches:next+1,results
    });
    if(saved!==true){
      const error=new Error('Model response checkpoint failed; automatic paid replay is prohibited.');
      error.nonRetryable=true;throw error;
    }
    next++;
    if(next<batches.length) return {
      status:'progress',posted:0,findings:[],coverage,
      progress:{completed_batches:next,total_batches:batches.length},
      summary:'Saved AI batch '+next+'/'+batches.length+
        '. Waiting for an authenticated worker continuation; not a completed review.'
    };
  }

  // Old checkpoints lacking this proof must not authorize a clean fallback.
  const unverifiedSuggestions=results.some(r=>r.unverifiedSuggestions!==false);
  const raw=results.flatMap(r=>r.findings);
  const rank={critical:0,high:1,medium:2,low:3};
  const findings=raw.sort((a,b)=>(rank[a.severity]??4)-(rank[b.severity]??4)||
    b.confidence-a.confidence)
    .filter((f,i,arr)=>arr.findIndex(g=>g.path===f.path&&g.line===f.line)===i)
    .slice(0,8);
  const review={findings,summary:results.map(r=>r.summary).join(' ').slice(0,1200)};
  const summary=coverageSummary(coverage)+' '+review.summary;
  const current=await api(pullPath,token);
  if(current.head?.sha!==headSha || current.state!=='open' ||
     (current.draft && !allowDraft)) return {
    status:'superseded',summary:'PR changed during staged analysis; no GitHub comments posted.',
    findings:[],posted:0
  };
  // Publish substantiated findings even when other suggestions were filtered.
  // Only a potentially false clean verdict must be blocked from approval.
  if(unverifiedSuggestions && findings.length===0)return {
    status:'partial',posted:0,findings,coverage,
    summary:(postMode==='dry-run'?'[Preview only] ':'')+summary+
      ' Some AI suggestions failed evidence validation or a prior checkpoint lacks verification. Manual inspection required; no GitHub review or fallback approval posted.'
  };
  if(postMode==='dry-run') return {
    status:'completed',summary:'[Preview only — not posted to GitHub] '+summary,
    findings,posted:0,coverage
  };
  const result=await (deps.postReview || postReview)({
    repoFullName:repository,prNumber:number,headSha,token,...review,summary,
    approval:postMode==='fallback' && findings.length===0
  });
  return {status:'completed',summary,findings,posted:result==='none'?0:1,coverage};
}
