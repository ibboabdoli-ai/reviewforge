import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { allowedRepositories,repositoryAllowed,dailyRequestLimit,reserveDailyReview,nextUtcDay } from '../src/review-policy.mjs';
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
  const sql=`INSERT INTO ai_daily_limits(day,used) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET used=ai_daily_limits.used+1 WHERE ai_daily_limits.used < ? RETURNING used`;
  assert.match(sqlForPostgres(sql),/VALUES\(\$1,1\)/);
  assert.match(sqlForPostgres(sql),/used < \$2/);
});
test('worker gate and cron auth are explicitly implemented',async()=>{
  const { readFileSync }=await import('node:fs');
  const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.match(server,/repositoryAllowed\(repo\.full_name,config\.aiAllowedRepositories\)/);
  assert.match(server,/reserveDailyReview\(db,config\.aiDailyRequestLimit\)/);
  assert.match(server,/req\.method==='GET'\?process\.env\.CRON_SECRET:process\.env\.WORKER_SECRET/);
});
