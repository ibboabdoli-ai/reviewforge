import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openDatabase} from '../src/db.mjs';
import {allowedRepositories,automaticShadowReviewDecision,effectiveReviewPostMode} from '../src/review-policy.mjs';

const target='ibboabdoli-ai/proffera';
const all=allowedRepositories(target);
const base={allowed:all,shadow:all,automatic:all,fallbackOnly:[]};
const decision=(action='opened',draft=true,opts=base,repository=target)=>
  automaticShadowReviewDecision({event:'pull_request',action,draft,repository},opts);

test('automatic Draft shadow review is explicitly triple-allowlisted, never broad',()=>{
  for(const action of ['opened','synchronize','reopened','ready_for_review']){
    assert.deepEqual(decision(action,true),{queue:true,automatic:true});
    assert.deepEqual(decision(action,false),{queue:true,automatic:true});
  }
  for(const missing of ['allowed','shadow','automatic']){
    const config={...base,[missing]:[]};
    assert.deepEqual(decision('opened',true,config),{queue:false,automatic:false});
  }
  assert.deepEqual(decision('opened',true,base,'ibboabdoli-ai/proffera-fork'),{queue:false,automatic:false});
  assert.deepEqual(decision('edited'),{queue:false,automatic:false});
  assert.deepEqual(automaticShadowReviewDecision({event:'issue_comment',action:'opened',repository:target,draft:false},base),
    {queue:false,automatic:false});
  assert.deepEqual(decision('opened',true,{...base,automatic:[]}),{queue:false,automatic:false});
});

test('existing non-Draft behavior and fallback-only exemptions remain opt-in',()=>{
  assert.deepEqual(decision('opened',false,{...base,automatic:[]}),{queue:true,automatic:false});
  assert.deepEqual(decision('opened',true,{...base,automatic:[]}),{queue:false,automatic:false});
  assert.deepEqual(decision('opened',false,{...base,automatic:[],fallbackOnly:all}),{queue:false,automatic:false});
  assert.deepEqual(decision('opened',false,{...base,fallbackOnly:all}),{queue:true,automatic:true});
  assert.equal(effectiveReviewPostMode(target,'live',all),'dry-run');
});

test('automatic Draft shadow reservation is deduplicated and permanently no-post marked',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-auto-shadow-'));
  const db=openDatabase(join(dir,'fixture.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'owner')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(17,1,'owner','active')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,enabled) VALUES(27,17,'Proffera','ibboabdoli-ai/Proffera','https://example.invalid/repo',1)").run();
    const props={installationId:17,repositoryId:27,prNumber:971,title:'Synthetic Draft',
      author:'owner',headSha:'a'.repeat(40),manual:decision().automatic};
    const first=await db.reserveReview(props);
    assert.equal(first.created,true);
    const saved=db.prepare('SELECT review_id FROM manual_review_requests WHERE review_id=?').get(first.id);
    assert.equal(Number(saved.review_id),first.id);
    const job=db.prepare('SELECT status FROM jobs WHERE review_id=?').get(first.id);
    assert.equal(job.status,'queued');
    const second=await db.reserveReview(props);
    assert.deepEqual(second,{id:first.id,created:false,manual:true});
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reviews').get().n,1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,1);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});

test('server uses the approved automatic decision only with a durable manual no-post marker',async()=>{
  const {readFileSync}=await import('node:fs');
  const server=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
  assert.match(server,/automaticShadowReviewDecision\(/);
  assert.match(server,/manual:autoPolicy\.automatic,unlimited:shadowUnlimited/);
  assert.match(server,/const manual=await db\.prepare\('SELECT review_id FROM manual_review_requests/);
  assert.match(server,/postMode:manual\?'dry-run':effectiveReviewPostMode/);
  assert.match(server,/allowDraft:!!manual/);
  assert.match(server,/reserveDailyReview\(db,config\.aiDailyRequestLimit,Date\.now\(\),count\)/);
});
