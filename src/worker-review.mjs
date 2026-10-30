import { manualReviewAllowed, enqueueManualReview, validPrNumber } from './manual-review.mjs';
import { repositoryAllowed } from './review-policy.mjs';

const shaPattern=/^[0-9a-f]{40}$/i;
export function workerReviewAllowed(repo,policy){
  return manualReviewAllowed(repo,policy)
    && repositoryAllowed(repo,policy.aiWorkerRequestRepositories);
}
export function validateWorkerReviewInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body))throw Object.assign(new Error('Invalid review request.'),{status:400});
  const keys=Object.keys(body);
  if(keys.length!==3||keys.some(k=>!['repository','pr_number','head_sha'].includes(k)))
    throw Object.assign(new Error('Only repository, pr_number, head_sha are accepted.'),{status:400});
  const repository=body.repository,pr=validPrNumber(body.pr_number),head=body.head_sha;
  if(typeof repository!=='string'||!/^[-a-zA-Z0-9_.]+\/[-a-zA-Z0-9_.]+$/.test(repository)||
      !pr||typeof head!=='string'||!shaPattern.test(head))
    throw Object.assign(new Error('Invalid repository, PR number, or commit SHA.'),{status:400});
  return {repository,pr,head:head.toLowerCase()};
}
/**
 * Service-to-service request: worker never supplies an arbitrary owner user ID
 * or GitHub token. The app resolves its installed, active repository owner
 * and reuses the existing exact-HEAD, owner-scoped, no-post manual flow.
 */
export async function requestWorkerReview(db,body,{policy,fetchPull,installationToken}){
  const {repository,pr,head}=validateWorkerReviewInput(body);
  if(!workerReviewAllowed(repository,policy))
    throw Object.assign(new Error('Repository not approved for worker shadow reviews.'),{status:403});
  const row=await db.prepare('SELECT p.full_name,i.owner_user_id FROM repositories p JOIN installations i ON i.id=p.installation_id WHERE lower(p.full_name)=? AND i.status=\'active\' AND p.enabled=1 AND lower(i.account_login)=?')
    .get(repository.toLowerCase(),repository.split('/')[0].toLowerCase());
  if(!row)throw Object.assign(new Error('Active owner installation not found.'),{status:403});
  return enqueueManualReview(db,{
    userId:row.owner_user_id,repoFullName:row.full_name,prNumber:String(pr),
    expectedHeadSha:head,policy,fetchPull,installationToken
  });
}
export async function getWorkerReviewStatus(db,params,policy){
  const {repository,pr,head}=validateWorkerReviewInput(params);
  if(!workerReviewAllowed(repository,policy))
    throw Object.assign(new Error('Repository not approved for worker shadow reviews.'),{status:403});
  const row=await db.prepare('SELECT r.id,r.status,r.summary,r.error,r.findings_json,r.posted,r.head_sha,j.status AS job_status,j.next_attempt_at FROM reviews r JOIN manual_review_requests m ON m.review_id=r.id JOIN jobs j ON j.review_id=r.id JOIN repositories p ON p.id=r.repository_id JOIN installations i ON i.id=r.installation_id WHERE lower(p.full_name)=? AND r.pr_number=? AND lower(r.head_sha)=? AND i.status=\'active\' AND p.enabled=1 AND lower(i.account_login)=?')
    .get(repository.toLowerCase(),pr,head,repository.split('/')[0].toLowerCase());
  if(!row)return null;
  let findings;
  try{findings=JSON.parse(row.findings_json||'[]')}catch{findings=[]}
  const expired=row.status==='running'&&row.job_status==='running'
    && Number.isFinite(Number(row.next_attempt_at))
    && Number(row.next_attempt_at)>0&&Number(row.next_attempt_at)<Date.now();
  return {id:row.id,status:expired?'stalled':row.status,
    summary:expired?'Execution lease expired; review was not completed.':row.summary,
    head_sha:row.head_sha,findings:Array.isArray(findings)?findings:[],
    error:expired?'Timed-out worker; awaiting safe failure reconciliation.':row.error||null,
    posted:Number(row.posted||0)};
}
