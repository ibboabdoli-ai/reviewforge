import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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
    other=openDatabase(path);
    // Both workers target the same queued review; only one may obtain it.
    const results=await Promise.all([Promise.resolve().then(()=>db.claimJob(first.id)),Promise.resolve().then(()=>other.claimJob(first.id))]);
    const wins=results.filter(Boolean);
    assert.equal(wins.length,1);
    assert.equal(wins[0].id,first.id);
    assert.equal(wins[0].attempts,1);
    assert.equal(db.prepare('SELECT attempts FROM jobs WHERE review_id=?').get(first.id).attempts,1);
    assert.equal(db.prepare('SELECT status FROM jobs WHERE review_id=?').get(second.id).status,'queued');
    db.prepare('UPDATE jobs SET next_attempt_at=? WHERE review_id=?').run(Date.now()+60000,second.id);
    assert.equal(other.claimJob(second.id),null);
    db.prepare('UPDATE jobs SET next_attempt_at=0 WHERE review_id=?').run(second.id);
    db.prepare('UPDATE repositories SET enabled=0 WHERE id=27').run();
    assert.equal(other.claimJob(second.id),null);
    db.prepare('UPDATE repositories SET enabled=1 WHERE id=27').run();
    assert.equal(other.claimJob(second.id).id,second.id);
  }finally{other?.close();db.close();rmSync(dir,{recursive:true,force:true});}
});
