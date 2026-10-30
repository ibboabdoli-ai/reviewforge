import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { allowedRepositories,repositoryAllowed,effectiveReviewPostMode,isUnlimitedShadowRepository,dailyRequestLimit,reserveDailyReview,nextUtcDay } from '../src/review-policy.mjs';
import { sqlForPostgres } from '../src/db-postgres.mjs';

test('repository allowlist defaults to deny all, matches only exact repos',()=>{
  assert.equal(repositoryAllowed('owner/repo',allowedRepositories('')),false);
  assert.deepEqual(allowedRepositories(' Owner/Test , owner/other, garbage '),['owner/test','owner/other']);
  assert.equal(repositoryAllowed('OWNER/Test',allowedRepositories('owner/test')),true);
  assert.equal(repositoryAllowed('owner/test-extra',allowedRepositories('owner/test')),false);
  assert.equal(repositoryAllowed('owner/test',allowedRepositories('bad input')),false);
});
test('daily budget configuration fails closed on invalid or oversized settings',()=>{
  assert.equal(dailyRequestLimit(undefined),1);
  assert.equal(dailyRequestLimit('2'),2);
  for(const invalid of ['-1','no','100','1.5'])assert.equal(dailyRequestLimit(invalid),0);
});
test('daily review reservations are bounded and atomically persisted',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'reviewforge-quota-'));
  const db=openDatabase(join(dir,'test.sqlite'));
  try{
    const t=Date.parse('2026-10-30T22:00:00Z');
    assert.equal(await reserveDailyReview(db,2,t),true);
    assert.equal(await reserveDailyReview(db,2,t),true);
    assert.equal(await reserveDailyReview(db,2,t),false);
    assert.equal(await reserveDailyReview(db,0,t),false);
    assert.equal(await reserveDailyReview(db,2,t+86400000),true);
    assert.equal(db.prepare('SELECT used FROM ai_daily_limits WHERE day=?').get('2026-10-30').used,2);
    assert.equal(nextUtcDay(t),Date.parse('2026-10-31T00:01:00Z'));
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('PostgreSQL receives a compatible parameterized atomic reservation',()=>{
  const sql=`INSERT INTO ai_daily_limits(day,used) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET used=ai_daily_limits.used+? WHERE ai_daily_limits.used+? <= ? RETURNING used`;
  assert.match(sqlForPostgres(sql),/VALUES\(\$1,\$2\)/);
  assert.match(sqlForPostgres(sql),/used\+\$4 <= \$5/);
});
test('worker gate and cron auth are explicitly implemented',async()=>{
  const { readFileSync }=await import('node:fs');
  const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.match(server,/repositoryAllowed\(repo\.full_name,config\.aiAllowedRepositories\)/);
  assert.match(server,/reserveDailyReview\(db,config\.aiDailyRequestLimit,Date\.now\(\),count\)/);
  assert.match(server,/req\.method==='GET'\?process\.env\.CRON_SECRET:process\.env\.WORKER_SECRET/);
});

test('atomically reserve exactly N model calls in the daily budget', async()=>{
 const {openDatabase}=await import('../src/db.mjs');
 const {reserveDailyReview}=await import('../src/review-policy.mjs');
 const {mkdtempSync,rmSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const root=mkdtempSync(join(tmpdir(),'rf-budget-'));
 const db=openDatabase(join(root,'test.sqlite'));
 try {
   const at=Date.UTC(2026,9,30,4);
   assert.equal(await reserveDailyReview(db,3,at,2),true);
   assert.equal(await reserveDailyReview(db,3,at,2),false);
   assert.equal(await reserveDailyReview(db,3,at,1),true);
   assert.equal(await reserveDailyReview(db,3,at,1),false);
   assert.equal(db.prepare('SELECT used FROM ai_daily_limits WHERE day=?').get('2026-10-30').used,3);
 } finally {db.close();rmSync(root,{recursive:true,force:true});}
});

test('shadow repositories cannot post reviews even when global mode is live',()=>{
 const shadow=allowedRepositories('ibboabdoli-ai/Proffera');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/Proffera','live',shadow),'dry-run');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/proffera','live',shadow),'dry-run');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/reviewforge-sandbox','live',shadow),'live');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/Proffera','dry-run',shadow),'dry-run');
});
test('shadow mode is explicitly passed into review pipeline',async()=>{
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(source,/postMode:manual\?'dry-run':effectiveReviewPostMode\(job\.full_name,config\.reviewPostMode,config\.aiShadowRepositories,\{/);
});

test('unlimited review count applies only to a permitted, exact shadow repository',()=>{
 const args={allowed:allowedRepositories('ibboabdoli-ai/proffera'),shadow:allowedRepositories('ibboabdoli-ai/proffera'),
  unlimited:allowedRepositories('ibboabdoli-ai/proffera')};
 assert.equal(isUnlimitedShadowRepository('ibboabdoli-ai/Proffera',args),true);
 assert.equal(isUnlimitedShadowRepository('ibboabdoli-ai/other',args),false);
 assert.equal(isUnlimitedShadowRepository('ibboabdoli-ai/proffera',{...args,allowed:[]}),false);
 assert.equal(isUnlimitedShadowRepository('ibboabdoli-ai/proffera',{...args,shadow:[]}),false);
 assert.equal(isUnlimitedShadowRepository('ibboabdoli-ai/proffera',{...args,unlimited:[]}),false);
});
test('server enforces per-repo monthly and daily limits',async()=>{
 const {readFileSync}=await import('node:fs');
 const source=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
 assert.match(source,/allowance\.used<allowance\.limit\|\|shadowUnlimited/);
 assert.match(source,/if\(shadowUnlimited\)return \{allowed:true\};/);
 assert.match(source,/postMode:manual\?'dry-run':effectiveReviewPostMode\(job\.full_name,config\.reviewPostMode,config\.aiShadowRepositories,\{/);
});

test('fallback publishing is disabled by default even for allowed shadow repositories',()=>{
 const shadow=allowedRepositories('ibboabdoli-ai/proffera');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/proffera','dry-run',shadow,{fallbackOnly:shadow,allowed:shadow}),'dry-run');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/proffera','dry-run',shadow,{approval:shadow,allowed:shadow}),'dry-run');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/proffera','dry-run',shadow,{fallbackOnly:shadow,approval:shadow,allowed:shadow}),'fallback');
 assert.equal(effectiveReviewPostMode('ibboabdoli-ai/other','dry-run',shadow,{fallbackOnly:shadow,approval:shadow,allowed:shadow}),'dry-run');
});
