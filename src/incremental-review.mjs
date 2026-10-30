import { createHash } from 'node:crypto';
import { config } from './config.mjs';
import { githubApi, installationToken, changedFiles, postReview } from './github.mjs';
import { planReviewBatches, coverageSummary, validateFindings, reviewWithAI } from './reviewer.mjs';
import { repositoryAllowed } from './review-policy.mjs';
import { selectReviewModel } from './model-router.mjs';

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
  // Never pay for a scan that is known to omit required diff hunks.
  if(!coverage.complete || !batches.length) return {
    status:'partial',posted:0,findings:[],coverage,
    summary:coverageSummary(coverage)+' Review incomplete; no AI calls made.'
  };

  const planHash=createHash('sha256').update(JSON.stringify({
    headSha,postMode,allowDraft,batches,coverage,
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
    const inserted=await deps.initProgress({
      reviewId,planHash,totalBatches:batches.length
    });
    if(inserted!==true){
      const error=new Error('Could not establish an exclusive checkpoint; model call blocked.');
      error.nonRetryable=true;throw error;
    }
  }

  if(next<batches.length){
    const batch=batches[next];
    const choice=repositoryAllowed(repository,config.aiAutoModelRepositories)
      ?selectReviewModel(batch,{fastModel:config.openai.modelFast,deepModel:config.openai.modelDeep})
      :null;
    const options={batchIndex:next+1,totalBatches:batches.length,
      ...(choice?{model:choice.model,reasoningEffort:choice.effort,modelTier:choice.tier}:{})};
    deps.onModelStart?.();
    let response;
    try{response=await (deps.reviewWithAI || reviewWithAI)(batch,options);}
    catch(error){error.nonRetryable=true;throw error;}
    const item={
      summary:'Batch '+(next+1)+'/'+batches.length+(choice?' ['+choice.model+']':'')+': '+String(response.summary||'').slice(0,350),
      findings:validateFindings(response.findings,batch)
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
