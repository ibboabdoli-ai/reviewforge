import { repositoryAllowed } from './review-policy.mjs';

/**
 * Manual requests are never GitHub approvals. A durable DB marker identifies
 * them, so even retries or future posting-policy changes remain dry-run.
 */
export function manualReviewAllowed(repository,config) {
  return repositoryAllowed(repository,config.aiManualReviewRepositories)
    && repositoryAllowed(repository,config.aiShadowRepositories)
    && repositoryAllowed(repository,config.aiAllowedRepositories);
}
export function validPrNumber(value) {
  const str=String(value??'');
  if(!/^[1-9][0-9]{0,7}$/.test(str))return null;
  const number=Number(str);
  return Number.isSafeInteger(number)?number:null;
}
export async function enqueueManualReview(db,{userId,repoFullName,prNumber,policy,fetchPull,installationToken}){
  if(!manualReviewAllowed(repoFullName,policy))throw Object.assign(new Error('Manual review is not enabled for this repository.'),{status:403});
  const number=validPrNumber(prNumber);
  if(!number)throw Object.assign(new Error('Invalid PR number.'),{status:400});
  // Ownership is checked server-side: never trust repository or installation IDs from the form.
  const repo=await db.prepare("SELECT p.id,p.installation_id,p.full_name FROM repositories p JOIN installations i ON i.id=p.installation_id WHERE p.full_name=? AND i.owner_user_id=? AND i.status='active' AND p.enabled=1").get(repoFullName,userId);
  if(!repo)throw Object.assign(new Error('Repository not accessible for manual review.'),{status:403});
  const token=await installationToken(repo.installation_id);
  const pull=await fetchPull('/repos/'+repo.full_name+'/pulls/'+number,token);
  const head=pull.head?.sha;
  if(pull.state!=='open'||pull.base?.ref!=='main'||!(/^[a-f0-9]{40}$/i.test(head||''))||pull.head?.repo?.full_name!==repo.full_name)
    throw Object.assign(new Error('PR must be open, target main, and originate from the connected repository.'),{status:409});
  const current=await db.prepare('SELECT id FROM reviews WHERE repository_id=? AND pr_number=? AND head_sha=?').get(repo.id,number,head);
  if(current){
    const manual=await db.prepare('SELECT review_id FROM manual_review_requests WHERE review_id=?').get(current.id);
    if(!manual)throw Object.assign(new Error('This commit already has an automated review; manual replay is not allowed.'),{status:409});
    return {id:current.id,headSha:head,created:false};
  }
  const inserted=await db.prepare("INSERT INTO reviews(installation_id,repository_id,pr_number,pr_title,author,head_sha,status,summary) VALUES(?,?,?,?,?,?,'queued','Manual shadow review requested; no GitHub posting.') ON CONFLICT(repository_id,pr_number,head_sha) DO NOTHING")
    .run(repo.installation_id,repo.id,number,String(pull.title||'').slice(0,250),String(pull.user?.login||''),head);
  const review=await db.prepare('SELECT id FROM reviews WHERE repository_id=? AND pr_number=? AND head_sha=?').get(repo.id,number,head);
  if(!review)throw new Error('Manual review insertion failed');
  if(!inserted.changes){
    const manual=await db.prepare('SELECT review_id FROM manual_review_requests WHERE review_id=?').get(review.id);
    if(!manual)throw Object.assign(new Error('Review already exists from a different trigger.'),{status:409});
    return {id:review.id,headSha:head,created:false};
  }
  // Marker is inserted BEFORE the job becomes available to workers.
  await db.prepare('INSERT INTO manual_review_requests(review_id) VALUES(?) ON CONFLICT(review_id) DO NOTHING').run(review.id);
  await db.prepare('INSERT INTO jobs(review_id) VALUES(?) ON CONFLICT(review_id) DO NOTHING').run(review.id);
  return {id:review.id,headSha:head,created:true};
}
