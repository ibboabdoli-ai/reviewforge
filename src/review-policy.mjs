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
export function effectiveReviewPostMode(repository,globalMode,shadowRepositories,{fallbackOnly=[],approval=[],allowed=[],forceDryRun=false}={}){
  if(forceDryRun)return 'dry-run';
  // All four explicit allowlists must agree before this exception is allowed.
  // Quota evidence is checked BEFORE the job is enqueued.
  if(repositoryAllowed(repository,shadowRepositories)){
    if(repositoryAllowed(repository,fallbackOnly) &&
       repositoryAllowed(repository,approval) &&
       repositoryAllowed(repository,allowed))return 'fallback';
    return 'dry-run';
  }
  return globalMode;
}
// Daily/monthly review-count exemptions apply only to explicitly approved
// shadow repositories, never to arbitrary tenants or repositories.
export function isUnlimitedShadowRepository(repository,{allowed=[],shadow=[],unlimited=[]}={}){
  return repositoryAllowed(repository,allowed)
    && repositoryAllowed(repository,shadow)
    && repositoryAllowed(repository,unlimited);
}
export function dailyRequestLimit(raw='1') {
  const limit=Number(raw);
  // Reject malformed, negative or excessive limits instead of falling back.
  return Number.isSafeInteger(limit) && limit>=0 && limit<=10 ? limit : 0;
}
// One persistent key across deployments: ten reserved model batches in total.
export const PROFFERA_PILOT_KEY='pilot-proffera-20261127';
export function pilotCallLimit(raw='0') {
  const n=Number(raw);
  return Number.isSafeInteger(n) && n>=0 && n<=10 ? n : 0;
}
export function isProffera(repository) {
  return typeof repository==='string' && repository.toLowerCase()==='ibboabdoli-ai/proffera';
}
export async function reserveProfferaPilotCalls(db,dailyLimit,pilotLimit,at=Date.now(),count=1){
  if(!Number.isSafeInteger(pilotLimit)||pilotLimit<1||pilotLimit>10||
     !Number.isSafeInteger(count)||count<1||count>pilotLimit)
    return {allowed:false,reason:'pilot-exhausted'};
  // Reserve the lifetime cap first. A later daily-limit rejection can consume
  // a pilot slot without a paid call; it can never overspend the pilot budget.
  const row=await db.prepare(`INSERT INTO ai_daily_limits(day,used) VALUES(?,?)
    ON CONFLICT(day) DO UPDATE SET used=ai_daily_limits.used+?
    WHERE ai_daily_limits.used+? <= ? RETURNING used`)
    .get(PROFFERA_PILOT_KEY,count,count,count,pilotLimit);
  if(!row)return {allowed:false,reason:'pilot-exhausted'};
  const daily=await reserveDailyReview(db,dailyLimit,at,count);
  return daily?{allowed:true}:{allowed:false,reason:'daily-used'};
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
