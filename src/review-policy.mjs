/**
 * Bounded, allowlisted beta review execution policy.
 * The daily counter uses an atomic database UPSERT so concurrent workers share
 * the same cap. Each attempt reserves BEFORE the model call (conservative).
 */
export function allowedRepositories(input='') {
  return String(input).split(',').map(v=>v.trim().toLowerCase())
    .filter(v=>/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(v));
}
export function repositoryAllowed(name,allowlist) {
  return typeof name==='string' && Array.isArray(allowlist)
    && allowlist.includes(name.toLowerCase());
}
/** Force approved shadow repositories into a no-post review mode,
 * even if an operator changes the global posting setting. */
export function effectiveReviewPostMode(repository,globalMode,shadowRepositories,{fallbackOnly=[],approval=[],allowed=[]}={}){
  // Configuration alone is not proof that this queued review originated
  // from an authentic exact-HEAD quota notice. Keep shadow reviews private
  // until durable quota provenance and a publication-time check exist.
  if(repositoryAllowed(repository,shadowRepositories))return 'dry-run';
  // A fallback-managed repository with a missing shadow entry must not
  // fall through to ordinary live posting on configuration drift.
  if(repositoryAllowed(repository,fallbackOnly) || repositoryAllowed(repository,approval))return 'dry-run';
  return globalMode;
}
// The owner authorized a monthly review-count exception for Proffera only.
// Other repositories retain their quotas even if all three lists include them.
export function isUnlimitedShadowRepository(repository,{allowed=[],shadow=[],unlimited=[]}={}){
  return repositoryAllowed(repository,['ibboabdoli-ai/proffera'])
    && repositoryAllowed(repository,allowed)
    && repositoryAllowed(repository,shadow)
    && repositoryAllowed(repository,unlimited);
}
export function dailyRequestLimit(raw='1') {
  const limit=Number(raw);
  // Reject malformed, negative or excessive limits instead of falling back.
  return Number.isSafeInteger(limit) && limit>=0 && limit<=10 ? limit : 0;
}
export async function reserveDailyReview(db,limit,at=Date.now(),count=1){
  if(!Number.isSafeInteger(limit)||limit<=0||
    !Number.isSafeInteger(count)||count<1||count>limit)return false;
  const day=new Date(at).toISOString().slice(0,10);
  // One atomic operation reserves the entire multi-batch review (no partial
  // spending if the remaining daily allowance is insufficient).
  const row=await db.prepare(`INSERT INTO ai_daily_limits(day,used) VALUES(?,?)
    ON CONFLICT(day) DO UPDATE SET used=ai_daily_limits.used+?
    WHERE ai_daily_limits.used+? <= ? RETURNING used`).get(day,count,count,count,limit);
  return !!row;
}
export function nextUtcDay(at=Date.now()){
  const today=new Date(at).toISOString().slice(0,10);
  return Date.parse(today+'T00:00:00.000Z')+86400000+60000;
}

/** Opt-in automatic private review for PRs including Draft.
 * Never accept a single wildcard or loose repository match.
 * This decision controls enqueue only; no-post is durably recorded per review.
 */
export function automaticShadowReviewDecision({event,action,repository,draft}={},{
  allowed=[],shadow=[],automatic=[],fallbackOnly=[]
}={}){
  const enabled=repositoryAllowed(repository,allowed) &&
    repositoryAllowed(repository,shadow) &&
    repositoryAllowed(repository,automatic);
  const queue=event==='pull_request' &&
    ['opened','synchronize','reopened','ready_for_review'].includes(action) &&
    repositoryAllowed(repository,allowed) &&
    (!repositoryAllowed(repository,fallbackOnly)||enabled) &&
    (!draft||enabled);
  return {queue,automatic:queue&&enabled};
}
