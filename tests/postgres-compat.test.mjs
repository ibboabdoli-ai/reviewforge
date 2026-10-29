import test from 'node:test';
import assert from 'node:assert/strict';
import {sqlForPostgres} from '../src/db-postgres.mjs';

test('Postgres SQL translation uses numbered parameters',()=>{
  assert.equal(sqlForPostgres('SELECT * FROM users WHERE login=? AND github_id=?'),
    'SELECT * FROM users WHERE login=$1 AND github_id=$2');
});
test('SQLite ignore inserts become conflict-safe Postgres inserts',()=>{
  assert.equal(sqlForPostgres('INSERT OR IGNORE INTO jobs(review_id) VALUES(?)'),
    'INSERT INTO jobs(review_id) VALUES($1) ON CONFLICT DO NOTHING');
});
test('monthly limits and cleanup use native Postgres time expressions',()=>{
  assert.equal(sqlForPostgres("SELECT * FROM reviews WHERE created_at>=datetime('now','start of month')"),
    "SELECT * FROM reviews WHERE created_at>=date_trunc('month',now())");
  assert.equal(sqlForPostgres("DELETE FROM deliveries WHERE received_at<datetime('now','-30 days')"),
    "DELETE FROM deliveries WHERE received_at<now() - interval '30 days'");
});
test('Postgres backend rejects unsafe DATABASE_URL before connection', async()=>{
  const {openPostgres}=await import('../src/db-postgres.mjs');
  await assert.rejects(()=>openPostgres('not-a-postgres-url'),/Invalid DATABASE_URL/);
});
