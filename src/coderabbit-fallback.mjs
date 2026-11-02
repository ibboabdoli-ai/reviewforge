/**
 * Only CodeRabbit itself can announce a quota-limited review in this route.
 * A signed GitHub webhook is necessary but NOT enough: the current PR head
 * must match an earlier trusted GitHub Actions exact-head review request.
 */
const QUOTA_NOTICE=/(?:\breview rate limited\b|\breview limit reached\b|\byour included review limit is currently reached\b|\brate limited by coderabbit\.ai\b)/i;
export function isCodeRabbitQuotaEvent(payload){
  return payload && ['created','edited'].includes(payload.action)
   && payload.comment?.user?.login==='coderabbitai[bot]'
   && payload.issue?.pull_request && Number.isSafeInteger(payload.issue.number)
   && payload.repository?.full_name
   && payload.installation?.id
   && QUOTA_NOTICE.test(String(payload.comment.body||'').slice(0,12000));
}
export function currentHeadReviewRequest(comments,headSha,botComment){
  if(!/^[0-9a-f]{40}$/.test(headSha||'')||!Array.isArray(comments))return null;
  const marker='<!-- proffera-coderabbit-final-review-request:'+headSha+' -->\n@coderabbitai review';
  const botAt=Date.parse(botComment?.created_at||'');
  if(!Number.isFinite(botAt))return null;
  const requests=comments.filter(c=>
    c.user?.login==='github-actions[bot]' &&
    String(c.body||'').trim()===marker &&
    Number.isFinite(Date.parse(c.created_at||'')) &&
    Date.parse(c.created_at)<=botAt &&
    botAt-Date.parse(c.created_at)<=30*60*1000);
  if(!requests.length)return null;
  return requests.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at))[0];
}
export function alreadyReviewedExactHead(reviews,inlineComments,headSha,requestTime){
  if(!Array.isArray(reviews)||!Array.isArray(inlineComments))return true; // fail closed
  const since=Date.parse(requestTime);
  if(!Number.isFinite(since))return true;
  return reviews.some(r=>r.user?.login==='coderabbitai[bot]' &&
       r.commit_id===headSha && Date.parse(r.submitted_at||'')>=since &&
       ['APPROVED','CHANGES_REQUESTED','COMMENTED'].includes(r.state)) ||
    inlineComments.some(c=>c.user?.login==='coderabbitai[bot]' &&
       (c.original_commit_id||c.commit_id)===headSha &&
       Date.parse(c.created_at||'')>=since);
}
