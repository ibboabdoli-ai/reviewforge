import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {dashboard,reviewsPage,reviewDetail,reposPage,manualReviewPage} from '../src/ui.mjs';
import {enqueueManualReview} from '../src/manual-review.mjs';
import {authorizedRepositoryIds} from '../src/github.mjs';
import {config} from '../src/config.mjs';

const alice={id:1,github_id:101,login:'alice'};
const bob={id:2,github_id:202,login:'bob'};
const publicRepo='org/alice-code',privateRepo='org/bob-secret';
const access=async (_db,user)=>new Set(user.id===alice.id?[11]:[12]);
const sha='a'.repeat(40);

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'rf-shared-installation-'));
  const db=openDatabase(join(dir,'data.sqlite'));
  db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'alice'),(2,202,'bob')").run();
  db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(7,1,'org','active')").run();
  db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,private,enabled) VALUES(11,7,'alice-code',?,'https://example.invalid/alice',0,1),(12,7,'bob-secret',?,'https://example.invalid/bob',1,1)").run(publicRepo,privateRepo);
  db.prepare("INSERT INTO reviews(installation_id,repository_id,pr_number,pr_title,head_sha,status,summary,findings_json) VALUES(7,11,1,'Alice PR',?,'completed','Alice summary','[]'),(7,12,2,'Bob private PR',?,'completed','Bob private summary',?)")
    .run(sha,sha,JSON.stringify([{path:'secret.js',line:1,severity:'high',title:'Bob private finding',body:'Private evidence'}]));
  return {db,dispose(){db.close();rmSync(dir,{recursive:true,force:true});}};
}

test('asymmetric users see only their own repository and review history',async()=>{
  const f=fixture();
  try{
    for(const [user,visible,hidden] of [[alice,publicRepo,privateRepo],[bob,privateRepo,publicRepo]]){
      const options={repositoryAccess:access};
      const pages=[await reposPage(f.db,user,'csrf',options),await reviewsPage(f.db,user,'csrf',options),
        await dashboard(f.db,user,'csrf',options)];
      for(const html of pages){assert.ok(html.includes(visible));assert.ok(!html.includes(hidden));}
    }
    assert.equal(await reviewDetail(f.db,alice,'csrf',2,{repositoryAccess:access}),null);
    assert.equal(await reviewDetail(f.db,bob,'csrf',1,{repositoryAccess:access}),null);
    const detail=await reviewDetail(f.db,bob,'csrf',2,{repositoryAccess:access});
    assert.match(detail,/Bob private finding/);
    assert.doesNotMatch(await reviewsPage(f.db,alice,'csrf',{repositoryAccess:access}),/Bob private PR/);
  }finally{f.dispose();}
});

test('manual review is denied to installation owner without repo access and allowed to shared user',async()=>{
  const f=fixture();
  try{
    let tokenCalls=0;
    const input={repoFullName:privateRepo,prNumber:'3',repositoryAccess:access,
      policy:{aiManualReviewRepositories:[privateRepo],aiShadowRepositories:[privateRepo],aiAllowedRepositories:[privateRepo]},
      installationToken:async()=>{tokenCalls++;return 'installation-token';},
      fetchPull:async()=>({state:'open',base:{ref:'main'},head:{sha:'b'.repeat(40),repo:{full_name:privateRepo}},title:'Safe test',user:{login:'bob'}})};
    await assert.rejects(enqueueManualReview(f.db,{...input,userId:alice.id}),/not accessible/);
    assert.equal(tokenCalls,0);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
    const created=await enqueueManualReview(f.db,{...input,userId:bob.id});
    assert.equal(created.created,true);
    assert.equal(tokenCalls,1);
  }finally{f.dispose();}
});

test('manual review selector excludes repos revoked from the signed-in user',async()=>{
  const f=fixture();
  const original=[config.aiManualReviewRepositories,config.aiShadowRepositories,config.aiAllowedRepositories,
    config.aiReviewEnabled,config.openai.apiKey];
  try{
    config.aiManualReviewRepositories=[publicRepo,privateRepo];
    config.aiShadowRepositories=[publicRepo,privateRepo];
    config.aiAllowedRepositories=[publicRepo,privateRepo];
    config.aiReviewEnabled=true;config.openai.apiKey='offline-test-only';
    const html=await manualReviewPage(f.db,alice,'csrf',new URLSearchParams(),{repositoryAccess:access});
    assert.match(html,/org\/alice-code/);
    assert.doesNotMatch(html,/org\/bob-secret/);
  }finally{[config.aiManualReviewRepositories,config.aiShadowRepositories,config.aiAllowedRepositories,
    config.aiReviewEnabled,config.openai.apiKey]=original;f.dispose();}
});

test('live GitHub user permissions are rechecked after revocation and fail closed on API errors',async()=>{
  const f=fixture();
  let bobRepos=[12];let broken=false;
  const api=async(path,token)=>{
    assert.match(token,/^user-[12]$/);
    if(broken)throw new Error('GitHub unavailable');
    if(path.startsWith('/user/installations?'))return {installations:[{id:7}]};
    if(path.startsWith('/user/installations/7/repositories?'))return {repositories:
      (token==='user-1'?[11]:bobRepos).map(id=>({id}))};
    throw new Error('Unexpected GitHub API request');
  };
  const repositoryAccess=(db,user)=>authorizedRepositoryIds(db,user,{api,userToken:async()=> 'user-'+user.id});
  try{
    assert.deepEqual([...await repositoryAccess(f.db,bob)],[12]);
    assert.match(await reviewDetail(f.db,bob,'csrf',2,{repositoryAccess}),/Bob private finding/);
    bobRepos=[11];
    assert.equal(await reviewDetail(f.db,bob,'csrf',2,{repositoryAccess}),null);
    assert.match(await reviewDetail(f.db,bob,'csrf',1,{repositoryAccess}),/Alice summary/);
    bobRepos=[];
    assert.deepEqual([...await repositoryAccess(f.db,bob)],[]);
    assert.equal(await reviewDetail(f.db,bob,'csrf',2,{repositoryAccess}),null);
    assert.doesNotMatch(await reposPage(f.db,bob,'csrf',{repositoryAccess}),/org\/bob-secret/);
    const input={userId:bob.id,repoFullName:privateRepo,prNumber:'3',repositoryAccess,
      policy:{aiManualReviewRepositories:[privateRepo],aiShadowRepositories:[privateRepo],aiAllowedRepositories:[privateRepo]},
      installationToken:async()=>{throw new Error('Unauthorized installation token use');},
      fetchPull:async()=>{throw new Error('Unauthorized pull request read');}};
    await assert.rejects(enqueueManualReview(f.db,input),/not accessible/);
    broken=true;
    await assert.rejects(reposPage(f.db,bob,'csrf',{repositoryAccess}),/GitHub unavailable/);
    await assert.rejects(enqueueManualReview(f.db,input),/GitHub unavailable/);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,0);
  }finally{f.dispose();}
});

test('PostgreSQL string identifiers and unlinked installations are handled without grants',async()=>{
  const f=fixture();
  try{
    const api=async path=>{
      if(path.startsWith('/user/installations?'))return {installations:[{id:7},{id:999}]};
      if(path.startsWith('/user/installations/7/repositories?'))return {repositories:[{id:11}]};
      throw new Error('Unlinked installation was queried');
    };
    const ids=await authorizedRepositoryIds(f.db,{id:'1',github_id:'101'},{api,userToken:async()=> 'alice'});
    assert.deepEqual([...ids],[11]);
    assert.deepEqual([...await authorizedRepositoryIds(f.db,{id:'1',github_id:null},{api,userToken:async()=> 'alice'})],[]);
  }finally{f.dispose();}
});
