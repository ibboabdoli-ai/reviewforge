import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openDatabase} from '../src/db.mjs';

test('SQLite claims a queued review once, even across two worker connections',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-claim-once-'));
  const path=join(dir,'fixture.sqlite');
  const db=openDatabase(path);
  let other;
  try{
    db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'owner')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(17,1,'owner','active')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,enabled) VALUES(27,17,'Proffera','ibboabdoli-ai/Proffera','https://example.invalid/repo',1)").run();
    const props={installationId:17,repositoryId:27,prNumber:971,title:'Synthetic',author:'owner',headSha:'b'.repeat(40)};
    const first=await db.reserveReview(props);
    const second=await db.reserveReview({...props,headSha:'c'.repeat(40)});
    const terminal=await db.reserveReview({...props,headSha:'d'.repeat(40)});
    other=openDatabase(path);
    // Both workers target the same queued review; only one may obtain it.
    const results=await Promise.all([Promise.resolve().then(()=>db.claimJob(first.id)),Promise.resolve().then(()=>other.claimJob(first.id))]);
    const wins=results.filter(Boolean);
    assert.equal(wins.length,1);
    assert.equal(wins[0].id,first.id);
    assert.equal(wins[0].attempts,1);
    // A worker may stop immediately after claim returns. The other connection
    // must already see both rows marked running, not a queued review.
    assert.equal(wins[0].status,'running');
    assert.equal(other.prepare('SELECT status FROM reviews WHERE id=?').get(first.id).status,'running');
    assert.equal(other.prepare('SELECT status FROM jobs WHERE review_id=?').get(first.id).status,'running');
    assert.equal(other.prepare('SELECT status FROM reviews WHERE id=?').get(second.id).status,'queued');
    db.prepare("UPDATE reviews SET status='failed' WHERE id=?").run(terminal.id);
    assert.equal(other.claimJob(terminal.id),null);
    assert.equal(db.prepare('SELECT attempts FROM jobs WHERE review_id=?').get(terminal.id).attempts,0);
    assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(terminal.id).status,'failed');
    assert.equal(db.prepare('SELECT attempts FROM jobs WHERE review_id=?').get(first.id).attempts,1);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE review_id=?').get(second.id).status,'queued');
    db.prepare('UPDATE jobs SET next_attempt_at=? WHERE review_id=?').run(Date.now()+60000,second.id);
    assert.equal(other.claimJob(second.id),null);
    db.prepare('UPDATE jobs SET next_attempt_at=0 WHERE review_id=?').run(second.id);
    db.prepare('UPDATE repositories SET enabled=0 WHERE id=27').run();
    assert.equal(other.claimJob(second.id),null);
    db.prepare('UPDATE repositories SET enabled=1 WHERE id=27').run();
    // A failure between the two writes must roll back the job claim too.
    db.exec(`CREATE TRIGGER block_claim_status BEFORE UPDATE OF status ON reviews
      WHEN NEW.id=${Number(second.id)} BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END;`);
    assert.throws(()=>other.claimJob(second.id),/synthetic write failure/);
    assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(second.id).status,'queued');
    assert.equal(db.prepare('SELECT status FROM jobs WHERE review_id=?').get(second.id).status,'queued');
    assert.equal(db.prepare('SELECT attempts FROM jobs WHERE review_id=?').get(second.id).attempts,0);
    db.exec('DROP TRIGGER block_claim_status');
    assert.equal(other.claimJob(second.id).id,second.id);
    assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(second.id).status,'running');
  }finally{other?.close();db.close();rmSync(dir,{recursive:true,force:true});}
});

test('SQLite server startup must not requeue an active or interrupted claim',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-startup-claim-'));
  const path=join(dir,'fixture.sqlite');
  const db=openDatabase(path);
  try{
    db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'owner')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(17,1,'owner','active')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,enabled) VALUES(27,17,'Proffera','ibboabdoli-ai/Proffera','https://example.invalid/repo',1)").run();
    const props={installationId:17,repositoryId:27,prNumber:971,title:'Synthetic',author:'owner',headSha:'b'.repeat(40)};
    const interrupted=await db.reserveReview(props);
    const continuation=await db.reserveReview({...props,headSha:'c'.repeat(40)});
    assert.equal(db.claimJob(interrupted.id).id,interrupted.id);
    // Import the real server in a separate process using the same disposable
    // database. No project .env, credentials, scheduler or network is available.
    const serverUrl=new URL('../src/server.mjs',import.meta.url).href;
    const env={NODE_ENV:'test',DEMO_MODE:'false',DB_PATH:path,AI_REVIEW_ENABLED:'false',
      ...(process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{})};
    const startup=spawnSync(process.execPath,['--input-type=module','--eval',
      'globalThis.fetch=()=>{throw new Error("network prohibited")}; await import('+JSON.stringify(serverUrl)+');'],
      {cwd:dir,env,encoding:'utf8',timeout:15000});
    assert.equal(startup.status,0,startup.stderr||String(startup.error||''));
    assert.equal(db.prepare('SELECT status FROM jobs WHERE review_id=?').get(interrupted.id).status,'running');
    assert.equal(db.prepare('SELECT status FROM reviews WHERE id=?').get(interrupted.id).status,'running');
    assert.equal(db.claimJob(interrupted.id),null);
    assert.equal(db.prepare('SELECT attempts FROM jobs WHERE review_id=?').get(interrupted.id).attempts,1);
    assert.equal(db.claimJob(continuation.id).id,continuation.id);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
