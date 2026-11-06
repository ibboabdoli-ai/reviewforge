import { repositoryAllowed,isUnlimitedShadowRepository } from './review-policy.mjs';

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
export async function enqueueManualReview(db,{userId,repoFullName,prNumber,expectedHeadSha=null,policy,fetchPull,installationToken}){
  if(!manualReviewAllowed(repoFullName,policy))throw Object.assign(new Error('Manual review is not enabled for this repository.'),{status:403});
  const number=validPrNumber(prNumber);
  if(!number)throw Object.assign(new Error('Invalid PR number.'),{status:400});
  // Ownership is checked server-side: never trust repository or installation IDs from the form.
  const repo=await db.prepare("SELECT p.id,p.installation_id,p.full_name FROM repositories p JOIN installations i ON i.id=p.installation_id WHERE p.full_name=? AND i.owner_user_id=? AND i.status='active' AND p.enabled=1").get(repoFullName,userId);
  if(!repo)throw Object.assign(new Error('Repository not accessible for manual review.'),{status:403});
  const token=await installationToken(repo.installation_id);
  const pull=await fetchPull('/repos/'+repo.full_name+'/pulls/'+number,token);
  const head=pull.head?.sha;
  if(expectedHeadSha !== null &&
     (!/^[a-f0-9]{40}$/i.test(expectedHeadSha) || expectedHeadSha.toLowerCase()!==String(head||'').toLowerCase()))
    throw Object.assign(new Error('PR HEAD changed or does not match requested SHA.'),{status:409});
  if(pull.state!=='open'||pull.base?.ref!=='main'||!(/^[a-f0-9]{40}$/i.test(head||''))||pull.head?.repo?.full_name!==repo.full_name)
    throw Object.assign(new Error('PR must be open, target main, and originate from the connected repository.'),{status:409});
  const unlimited=isUnlimitedShadowRepository(repo.full_name,{
    allowed:policy.aiAllowedRepositories,shadow:policy.aiShadowRepositories,
    unlimited:policy.aiUnlimitedRepositories
  });
  const reserved=await db.reserveReview({installationId:repo.installation_id,repositoryId:repo.id,
    prNumber:number,title:String(pull.title||'').slice(0,250),author:String(pull.user?.login||''),
    headSha:head,manual:true,unlimited});
  if(!reserved.manual)throw Object.assign(new Error('This commit already has an automated review; manual replay is not allowed.'),{status:409});
  return {id:reserved.id,headSha:head,created:reserved.created};
}
