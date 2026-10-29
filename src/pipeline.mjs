import { config } from './config.mjs';
import { githubApi, installationToken, changedFiles, postReview } from './github.mjs';
import { safeFiles, reviewWithAI } from './reviewer.mjs';

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
  const files=safeFiles(await filesFor({repoFullName:repository,prNumber:number,token}));
  const review=await ai(files);
  const latest=await api(pullPath,token);
  if (latest.head?.sha!==headSha || latest.draft || latest.state!=='open') {
    return {status:'superseded',summary:'PR changed during analysis; no comments posted.',findings:[],posted:0};
  }
  if (postMode==='dry-run') {
    return {status:'completed',summary:`[Preview only — not posted to GitHub] ${review.summary}`,findings:review.findings,posted:0};
  }
  if (!files.length) return {status:'completed',summary:review.summary,findings:review.findings,posted:0};
  const postResult=await post({repoFullName:repository,prNumber:number,headSha,token,...review});
  return {status:'completed',summary:review.summary,findings:review.findings,posted:postResult==='none'?0:1};
}
