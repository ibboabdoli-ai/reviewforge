import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {dashboard,reviewsPage,reviewDetail,reposPage,manualReviewPage,billingPage} from '../src/ui.mjs';
import {enqueueManualReview} from '../src/manual-review.mjs';
import {authorizedRepositoryIds,authorizedRepositoryGrants,syncInstallations,githubUserToken} from '../src/github.mjs';
import {config} from '../src/config.mjs';
import {encrypt} from '../src/security.mjs';

const alice={id:1,github_id:101,login:'alice'};
const bob={id:2,github_id:202,login:'bob'};
const publicRepo='org/alice-code',privateRepo='org/bob-secret';
const access=async (_db,user)=>new Map([[user.id===alice.id?11:12,7]]);
const sha='a'.repeat(40);

test('missing GitHub authorization requests sign-in instead of an unclassified server error',async()=>{
  await assert.rejects(githubUserToken(null,{id:1,token_cipher:null}),error=>
    error.status===401&&error.githubReauth===true&&/sign in again/.test(error.message));
});

test('a canceled billing owner can see the Checkout action again',async()=>{
  const f=fixture(),previous=[config.stripe.secret,config.stripe.webhookSecret,config.stripe.pricePro];
  try{
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_old','sub_old','canceled')").run();
    config.stripe.secret='sk_test_synthetic';config.stripe.webhookSecret='whsec_synthetic';config.stripe.pricePro='price_synthetic';
    const html=await billingPage(f.db,alice,'csrf');
    assert.match(html,/Choose Pro/);
  }finally{[config.stripe.secret,config.stripe.webhookSecret,config.stripe.pricePro]=previous;f.dispose();}
});

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
test('a shared member sees the installation billing owner quota',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_test','sub_test','active')").run();
    const html=await dashboard(f.db,bob,'csrf',{repositoryAccess:access});
    assert.match(html,/Current plan: PRO/);
    assert.match(html,/2 <span>\/ 500 reviews/);
  }finally{f.dispose();}
});
test('dashboard separates quotas when a user can access different billing owners',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO subscriptions(user_id,stripe_customer_id,stripe_subscription_id,status) VALUES(1,'cus_test','sub_test','active')").run();
    f.db.prepare("INSERT INTO installations(id,owner_user_id,account_login) VALUES(8,2,'second')").run();
    f.db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url) VALUES(13,8,'repo','second/repo','https://example.invalid/second')").run();
    const grants=async()=>new Map([[12,7],[13,8]]);
    const html=await dashboard(f.db,bob,'csrf',{repositoryAccess:grants});
    assert.match(html,/org: PRO · 2 \/ 500 reviews/);
    assert.match(html,/second: FREE · 0 \/ 10 reviews/);
  }finally{f.dispose();}
});

test('a repository transfer after the live grant cannot disclose destination findings',async()=>{
  const f=fixture();
  try{
    f.db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(8,2,'other','active')").run();
    f.db.prepare("INSERT INTO reviews(installation_id,repository_id,pr_number,pr_title,head_sha,status,summary,findings_json) VALUES(8,12,8,'Other tenant secret',?,'completed','Other tenant summary',?)")
      .run('c'.repeat(40),JSON.stringify([{path:'private.js',line:1,title:'Other tenant finding'}]));
    const api=async path=>path.startsWith('/user/installations?')?{installations:[{id:7}]}:{repositories:[{id:12}]};
    const access=async(db,user)=>{
      const grants=await authorizedRepositoryGrants(db,user,{api,userToken:async()=> 'user-token'});
      db.prepare('UPDATE repositories SET installation_id=8 WHERE id=12').run();
      return grants;
    };
    const pages=[await reviewsPage(f.db,bob,'csrf',{repositoryAccess:access}),
      await dashboard(f.db,bob,'csrf',{repositoryAccess:access}),
      await reposPage(f.db,bob,'csrf',{repositoryAccess:access})];
    for(const html of pages)assert.doesNotMatch(html,/Other tenant secret|Other tenant summary|org\/bob-secret/);
    assert.equal(await reviewDetail(f.db,bob,'csrf',3,{repositoryAccess:access}),null);
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
test('manual review selects the active association granted to the user',async()=>{
  const f=fixture();try{
    f.db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(8,2,'org','active')").run();
    f.db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,enabled) VALUES(13,8,'bob-secret',?,'https://example.invalid/new',1)").run(privateRepo);
    const access=async()=>new Map([[13,8]]);
    const installations=[];
    const created=await enqueueManualReview(f.db,{userId:bob.id,repoFullName:privateRepo,prNumber:'4',repositoryAccess:access,
      policy:{aiManualReviewRepositories:[privateRepo],aiShadowRepositories:[privateRepo],aiAllowedRepositories:[privateRepo]},
      installationToken:async id=>{installations.push(id);return 'token';},
      fetchPull:async()=>({state:'open',base:{ref:'main'},head:{sha:'d'.repeat(40),repo:{full_name:privateRepo}},title:'New repo',user:{login:'bob'}})});
    assert.equal(created.created,true);
    assert.deepEqual(installations,[8]);
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
  const repositoryAccess=(db,user)=>authorizedRepositoryGrants(db,user,{api,userToken:async()=> 'user-'+user.id});
  try{
    assert.deepEqual([...await repositoryAccess(f.db,bob)],[[12,7]]);
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
test('authorization normalizes PostgreSQL string-valued repository rows',async()=>{
  const user={id:'1',github_id:'101'};
  const db={prepare:sql=>({
    get:async()=>user,
    all:async()=>{assert.match(sql,/i\.id IN/);return [{id:'11',installation_id:'7'}];}
  })};
  const api=async path=>path.startsWith('/user/installations?')
    ?{installations:[{id:7}]}:{repositories:[{id:11}]};
  const grants=await authorizedRepositoryGrants(db,user,{api,userToken:async()=> 'token'});
  assert.deepEqual([...grants],[[11,7]]);
});

test('exactly 500 user-accessible repositories remain available; more than 500 fail closed',async()=>{
  const f=fixture();
  const api=async path=>{
    if(path.startsWith('/user/installations?'))return {installations:[{id:7}]};
    const page=Number(new URL(path,'https://example.invalid').searchParams.get('page'));
    if(page>=1&&page<=5)return {total_count:500,repositories:Array.from({length:100},(_,i)=>{
      const id=(page-1)*100+i+1;
      return {id,name:'repo-'+id,full_name:'org/repo-'+id,html_url:'https://example.invalid/'+id,private:false};
    })};
    throw new Error('Unexpected page');
  };
  try{
    assert.deepEqual(await syncInstallations(f.db,bob,{api,userToken:async()=> 'bob-token'}),{linked:1,repoCount:500});
    const ids=await authorizedRepositoryIds(f.db,bob,{api,userToken:async()=> 'bob-token'});
    assert.equal(ids.size,500);
    const over=async path=>{
      const result=await api(path);
      return result.repositories?{...result,total_count:501}:result;
    };
    await assert.rejects(authorizedRepositoryIds(f.db,bob,{api:over,userToken:async()=> 'bob-token'}),/pagination bound/);
  }finally{f.dispose();}
});

test('a failed second GitHub page never exposes findings from a partial first page',async()=>{
  const f=fixture();
  const api=async path=>{
    if(path.startsWith('/user/installations?'))return {installations:[{id:7}]};
    const page=Number(new URL(path,'https://example.invalid').searchParams.get('page'));
    if(page===1)return {repositories:Array.from({length:100},(_,i)=>({id:i+1}))};
    throw new Error('GitHub page two unavailable');
  };
  const repositoryAccess=(db,user)=>authorizedRepositoryGrants(db,user,{api,userToken:async()=> 'bob-token'});
  try{
    await assert.rejects(reviewDetail(f.db,bob,'csrf',2,{repositoryAccess}),/page two unavailable/);
  }finally{f.dispose();}
});

test('expired user token denies reads, while a current user token preserves access',async()=>{
  const f=fixture();
  let calls=0;
  const api=async(path,token)=>{
    calls++;assert.equal(token,'fresh-user-token');
    if(path.startsWith('/user/installations?'))return {installations:[{id:7}]};
    return {repositories:[{id:12}]};
  };
  try{
    f.db.prepare('UPDATE users SET token_cipher=?,token_expires_at=? WHERE id=?')
      .run(encrypt('expired-user-token',config.sessionSecret),Date.now()-1000,bob.id);
    await assert.rejects(authorizedRepositoryIds(f.db,bob,{api}),/token expired/);
    assert.equal(calls,0);
    f.db.prepare('UPDATE users SET token_cipher=?,token_expires_at=? WHERE id=?')
      .run(encrypt('fresh-user-token',config.sessionSecret),Date.now()+3600000,bob.id);
    assert.deepEqual([...await authorizedRepositoryIds(f.db,bob,{api})],[12]);
    assert.equal(calls,2);
  }finally{f.dispose();}
});

test('GitHub authorization expiry stays fail-closed with reauthentication status',async()=>{
  const user={id:1,login:'alice'};
  const pages=[
    access=>dashboard(null,user,'csrf',{repositoryAccess:access}),
    access=>reviewsPage(null,user,'csrf',{repositoryAccess:access}),
    access=>reviewDetail(null,user,'csrf',1,{repositoryAccess:access}),
    access=>reposPage(null,user,'csrf',{repositoryAccess:access}),
    access=>manualReviewPage(null,user,'csrf',new URLSearchParams(),{repositoryAccess:access})
  ];
  for(const message of [
    'GitHub authorization missing; sign in again.',
    'GitHub authorization expired; please sign in again.'
  ]){
    const access=async()=>{throw new Error(message);};
    for(const page of pages)
      await assert.rejects(()=>page(access),error=>error.status===401&&error.message===message);
  }
});
test('unrelated GitHub failures and invalid grant shapes are not made into reauthentication',async()=>{
  const user={id:1,login:'alice'};
  const failure=new Error('GitHub API connection failed');
  await assert.rejects(()=>reviewsPage(null,user,'csrf',{repositoryAccess:async()=>{throw failure;}}),
    error=>error===failure && error.status===undefined);
  await assert.rejects(()=>reposPage(null,user,'csrf',{repositoryAccess:async()=>[]}),
    /Repository authorization lacks installation identity/);
});
