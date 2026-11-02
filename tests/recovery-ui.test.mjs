import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db.mjs';
import {reviewsPage,reviewDetail} from '../src/ui.mjs';

test('dashboard list distinguishes failed reviews from pending and shows incremental checkpoints',async()=>{
 const root=mkdtempSync(join(tmpdir(),'rf-ui-recovery-'));
 const db=openDatabase(join(root,'test.sqlite'));
 try{
  db.prepare("INSERT INTO users(id,login,name) VALUES(9,'owner','Owner')").run();
  db.prepare("INSERT INTO installations(id,owner_user_id,account_login) VALUES(42,9,'owner')").run();
  db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url) VALUES(123,42,'repo','owner/repo','https://github.com/owner/repo')").run();
  const sha='a'.repeat(40);
  db.prepare("INSERT INTO reviews(id,installation_id,repository_id,pr_number,pr_title,head_sha,status,summary) VALUES(1,42,123,943,'Maria',?,'failed','The worker timed out')").run(sha);
  db.prepare("INSERT INTO reviews(id,installation_id,repository_id,pr_number,pr_title,head_sha,status,summary) VALUES(2,42,123,953,'Directory',?,'queued','Batch 1/2 saved')").run('b'.repeat(40));
  db.prepare("INSERT INTO review_progress(review_id,plan_hash,total_batches,completed_batches) VALUES(2,?,2,1)").run('c'.repeat(64));
  const html=await reviewsPage(db,{id:9,login:'owner'},'test-csrf');
  assert.match(html,/Review failed/);
  assert.match(html,/Batch 1\/2/);
  assert.doesNotMatch(html,/>✓ Clean<\/span>/);
  const detail=await reviewDetail(db,{id:9,login:'owner'},'test-csrf',1);
  assert.match(detail,/No reliable findings or clean verdict/);
  assert.doesNotMatch(detail,/No findings recorded for this review/);
  const progress=await reviewDetail(db,{id:9,login:'owner'},'test-csrf',2);
  assert.match(progress,/Batch progress: 1\/2/);
 }finally{db.close();rmSync(root,{recursive:true,force:true});}
});
