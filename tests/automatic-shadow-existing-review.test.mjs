import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.mjs';

// Synthetic SQLite fixture: no real GitHub/Neon data, webhook, model, or posting.
async function withReview(work) {
  const dir = mkdtempSync(join(tmpdir(), 'rf-shadow-upgrade-'));
  const db = openDatabase(join(dir, 'fixture.sqlite'));
  try {
    db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'owner')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(17,1,'owner','active')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,enabled) VALUES(27,17,'Proffera','ibboabdoli-ai/Proffera','https://example.invalid/repo',1)").run();
    const props = { installationId:17, repositoryId:27, prNumber:971,
      title:'Synthetic only', author:'owner', headSha:'b'.repeat(40) };
    await work(db, props);
  } finally {
    db.close();
    rmSync(dir, {recursive:true, force:true});
  }
}

test('a queued regular review re-reserved as auto-shadow becomes durably no-post, without duplicate job', async () => {
  await withReview(async (db, props) => {
    const first = await db.reserveReview({...props, manual:false});
    assert.equal(first.created, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manual_review_requests').get().n, 0);
    const shadow = await db.reserveReview({...props, manual:true});
    assert.deepEqual(shadow, {id:first.id, created:false, manual:true});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manual_review_requests WHERE review_id=?').get(first.id).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE review_id=?').get(first.id).n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n, 1);
  });
});

test('a running non-shadow review cannot be retroactively labeled safe/no-post', async () => {
  await withReview(async (db, props) => {
    const first = await db.reserveReview({...props, manual:false});
    db.prepare("UPDATE jobs SET status='running' WHERE review_id=?").run(first.id);
    const shadow = await db.reserveReview({...props, manual:true});
    assert.deepEqual(shadow, {id:first.id, created:false, manual:false});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM manual_review_requests WHERE review_id=?').get(first.id).n, 0);
  });
});
