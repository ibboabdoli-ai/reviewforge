import { config } from './config.mjs';
import { githubApi, installationToken, changedFiles, postReview } from './github.mjs';
import { planReviewBatches, coverageSummary, validateFindings, reviewWithAI } from './reviewer.mjs';

/**
 * Review pipeline. All GitHub write operations are disabled by default.
 * Pure dependency injection lets integration tests exercise the complete pipeline
 * without sending source code to a model or posting to a real repository.
 */
export async function analyzePullRequest({ repository, number, headSha, installationId, postMode=config.reviewPostMode }, deps={}) {
  if (!['dry-run', 'live'].includes(postMode)) throw new Error('Invalid review post mode');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !Number.isSafeInteger(number) || number<=0 ||
      !/^[0-9a-f]{40}$/i.test(headSha) || !Number.isSafeInteger(Number(installationId))) {
    throw new Error('Invalid review target');
  }
  const api=deps.githubApi || githubApi;
  const tokenFor=deps.installationToken || installationToken;
  const filesFor=deps.changedFiles || changedFiles;
  const ai=deps.reviewWithAI || reviewWithAI;
  const post=deps.postReview || postReview;
  const token=await tokenFor(installationId);
  const pullPath=`/repos/${repository}/pulls/${number}`;
  const initial=await api(pullPath,token);
  if (initial.head?.sha!==headSha) {
    return {status:'superseded',summary:'The pull request head changed before review.',findings:[],posted:0};
  }
  if (initial.draft || initial.state!=='open') {
    return {status:'skipped',summary:'Pull request is draft or no longer open.',findings:[],posted:0};
  }
  const {batches,coverage}=planReviewBatches(await filesFor({repoFullName:repository,prNumber:number,token}));
  // Reserve all model attempts BEFORE the first model call. An insufficient
  // global daily cap must not result in a half-reviewed PR or overspend.
  if(batches.length && deps.reserveModelCalls){
    const reservation=await deps.reserveModelCalls(batches.length);
    if(reservation!==true && reservation?.allowed!==true){
      const insufficient=reservation?.reason==='requires-higher-cap';
      return {status:insufficient?'partial':'deferred',posted:0,findings:[],coverage,
        summary:insufficient
          ? 'AI review not started: this PR needs '+batches.length+' model batches, which exceeds the configured daily allowance. No model calls made.'
          : 'AI daily request allowance exhausted; review deferred until next UTC day. No model calls made.'};
    }
  }
  const summaries=[],rawFindings=[];
  for(let index=0;index<batches.length;index++){
    const part=batches[index];
    const response=await ai(part,{batchIndex:index+1,totalBatches:batches.length});
    summaries.push('Batch '+(index+1)+'/'+batches.length+': '+String(response.summary||'').slice(0,350));
    rawFindings.push(...validateFindings(response.findings,part));
  }
  const severityRank={critical:0,high:1,medium:2,low:3};
  const findings=rawFindings.sort((a,b)=>(severityRank[a.severity]??4)-(severityRank[b.severity]??4)||b.confidence-a.confidence)
    .filter((f,i,all)=>all.findIndex(g=>g.path===f.path&&g.line===f.line)===i).slice(0,8);
  const review={summary:summaries.join(' ').slice(0,1200)||'No reviewable text patches were available.',findings};
  const summary=coverageSummary(coverage)+' '+review.summary;
  const latest=await api(pullPath,token);
  if (latest.head?.sha!==headSha || latest.draft || latest.state!=='open') {
    return {status:'superseded',summary:'PR changed during analysis; no comments posted.',findings:[],posted:0};
  }
  if (!coverage.complete || !batches.length) {
    // Never label a partial scan 'clean' or publish an incomplete review.
    return {status:'partial',summary:(postMode==='dry-run'?'[Preview only] ':'')+summary,findings:review.findings,posted:0,coverage};
  }
  if (postMode==='dry-run') {
    return {status:'completed',summary:`[Preview only — not posted to GitHub] ${summary}`,findings:review.findings,posted:0,coverage};
  }
  const postResult=await post({repoFullName:repository,prNumber:number,headSha,token,...review,summary});
  return {status:'completed',summary,findings:review.findings,posted:postResult==='none'?0:1,coverage};
}
