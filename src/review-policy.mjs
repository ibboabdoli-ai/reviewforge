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
