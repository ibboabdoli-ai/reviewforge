import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {syncInstallations,authorizedRepositoryGrants,githubUserToken,upsertInstalledRepository} from '../src/github.mjs';
import {reviewsPage,reviewDetail,reposPage} from '../src/ui.mjs';
import {config} from '../src/config.mjs';
import {encrypt} from '../src/security.mjs';

test('concurrent OAuth refresh reuses the token saved by the winning request',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-oauth-race-'));
  const db=openDatabase(join(dir,'data.sqlite'));
  const originalFetch=globalThis.fetch;
  try{
    db.prepare('INSERT INTO users(id,github_id,login,token_cipher,refresh_cipher,token_expires_at) VALUES(?,?,?,?,?,?)')
      .run(1,101,'alice',encrypt('old-access',config.sessionSecret),encrypt('single-use-refresh',config.sessionSecret),Date.now()-1000);
    const user=db.prepare('SELECT * FROM users WHERE id=1').get();
    let calls=0,first;
    globalThis.fetch=async()=>{
      if(++calls===1)return {ok:true,json:async()=>({access_token:'fresh-access',refresh_token:'next-refresh',expires_in:3600})};
      await first;
      return {ok:false,json:async()=>({error:'bad_refresh_token'})};
    };
    first=githubUserToken(db,user);
    const second=githubUserToken(db,user);
    assert.deepEqual(await Promise.all([first,second]),['fresh-access','fresh-access']);
  }finally{globalThis.fetch=originalFetch;db.close();rmSync(dir,{recursive:true,force:true});}
});

test('shared installation sync keeps billing owner and other members repositories',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-shared-sync-'));
  const db=openDatabase(join(dir,'data.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'alice'),(2,202,'bob')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(7,1,'org','active')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,enabled) VALUES(11,7,'alice','org/alice','https://example.invalid/alice',1)").run();
    const api=async path=>{
      if(path.startsWith('/user/installations?'))return {installations:[{id:7,account:{login:'org'}}]};
      if(path.startsWith('/user/installations/7/repositories?'))return {repositories:[
        {id:12,name:'bob',full_name:'org/bob',html_url:'https://example.invalid/bob',private:true}
      ]};
      throw new Error('Unexpected GitHub API request');
    };
    assert.deepEqual(await syncInstallations(db,{id:2},{api,userToken:async()=> 'bob-user-token'}),{linked:1,repoCount:1});
    assert.equal(db.prepare('SELECT owner_user_id FROM installations WHERE id=7').get().owner_user_id,1);
    assert.equal(db.prepare('SELECT enabled FROM repositories WHERE id=11').get().enabled,1);
    assert.equal(db.prepare('SELECT full_name FROM repositories WHERE id=12').get().full_name,'org/bob');
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('synchronization waits for deferred installation and repository writes',async()=>{
  let releaseInstallation,releaseRepository,repositoryEntered,settled=false;
  const installationGate=new Promise(resolve=>{releaseInstallation=resolve;});
  const repositoryGate=new Promise(resolve=>{releaseRepository=resolve;});
  const repoStarted=new Promise(resolve=>{repositoryEntered=resolve;});
  const db={prepare:sql=>({
    get:async()=>undefined,
    run:async()=>{
      if(sql.includes('INSERT INTO installations'))await installationGate;
      if(sql.includes('INSERT INTO repositories')){repositoryEntered();await repositoryGate;}
    }
  })};
  const api=async path=>path.startsWith('/user/installations?')
    ?{installations:[{id:7,account:{login:'org'}}]}
    :{repositories:[{id:12,name:'repo',full_name:'org/repo',html_url:'https://example.invalid/repo'}]};
  const pending=syncInstallations(db,{id:1},{api,userToken:async()=> 'token'}).then(result=>{settled=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(settled,false);
  releaseInstallation();
  await repoStarted;
  assert.equal(settled,false);
  releaseRepository();
  assert.deepEqual(await pending,{linked:1,repoCount:1});
});

test('repository transfer repairs installation association and hides old-tenant review findings',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-transfer-'));
  const db=openDatabase(join(dir,'data.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'alice'),(2,202,'bob')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(7,1,'old-org','active'),(8,2,'new-org','active')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url,enabled) VALUES(12,7,'repo','old-org/repo','https://example.invalid/old',1)").run();
    db.prepare("INSERT INTO reviews(id,installation_id,repository_id,pr_number,pr_title,head_sha,status,summary,findings_json) VALUES(41,7,12,1,'Old private PR',?,'completed','Old private summary',?)")
      .run('a'.repeat(40),JSON.stringify([{title:'Old secret finding'}]));
    const api=async path=>{
      if(path.startsWith('/user/installations?'))return {installations:[{id:8,account:{login:'new-org'}}]};
      if(path.startsWith('/user/installations/8/repositories?'))return {repositories:[
        {id:12,name:'repo',full_name:'new-org/repo',html_url:'https://example.invalid/new',private:true}
      ]};
      if(path.startsWith('/installation/repositories?'))return {repositories:[{id:12,full_name:'new-org/repo'}]};
      throw new Error('Unexpected GitHub API request');
    };
    const bob={id:2,github_id:202,login:'bob'};
    const repositoryAccess=(db,user)=>authorizedRepositoryGrants(db,user,{api,userToken:async()=> 'bob-token'});
    assert.deepEqual([...await repositoryAccess(db,bob)],[]);
    assert.doesNotMatch(await reposPage(db,bob,'csrf',{repositoryAccess}),/old-org\/repo/);
    assert.equal(await reviewDetail(db,bob,'csrf',41,{repositoryAccess}),null);
    await syncInstallations(db,bob,{api,userToken:async()=> 'bob-token',installToken:async()=> 'installation-token'});
    assert.equal(db.prepare('SELECT installation_id FROM repositories WHERE id=12').get().installation_id,8);
    db.prepare("INSERT INTO reviews(id,installation_id,repository_id,pr_number,pr_title,head_sha,status,summary) VALUES(42,8,12,2,'New PR',?,'completed','New summary')").run('b'.repeat(40));
    const options={repositoryAccess};
    const pages=[await reposPage(db,bob,'csrf',options),
      await reviewsPage(db,bob,'csrf',options)];
    assert.match(pages[0],/new-org\/repo/);
    assert.match(pages[1],/New summary|New PR/);
    for(const html of pages)assert.doesNotMatch(html,/Old private PR|Old secret finding|old-org\/repo/);
    assert.equal(await reviewDetail(db,bob,'csrf',41,options),null);
    assert.match(await reviewDetail(db,bob,'csrf',42,options),/New summary/);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
test('a stale installation snapshot cannot rebind a transferred repository',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rf-stale-sync-'));
  const db=openDatabase(join(dir,'db.sqlite'));
  try{
    db.prepare("INSERT INTO users(id,github_id,login) VALUES(1,101,'alice')").run();
    db.prepare("INSERT INTO installations(id,owner_user_id,account_login) VALUES(7,1,'old'),(8,1,'new')").run();
    db.prepare("INSERT INTO repositories(id,installation_id,name,full_name,html_url) VALUES(12,8,'repo','new/repo','https://example.invalid/new')").run();
    const api=async(path,token)=>{
      if(path.startsWith('/user/installations?'))return {installations:[{id:7,account:{login:'old'}}]};
      if(path.startsWith('/user/installations/7/repositories?'))return {repositories:[{id:12,name:'repo',full_name:'old/repo',html_url:'https://example.invalid/old'}]};
      if(path.startsWith('/installation/repositories?') && token==='installation-token')return {repositories:[]};
      if(path==='/repos/old/repo')return {id:12,full_name:'old/repo'}; // Public metadata is not installation membership.
      throw new Error('Unexpected GitHub API request');
    };
    await syncInstallations(db,{id:1},{api,userToken:async()=> 'user-token',installToken:async()=> 'installation-token'});
    assert.equal(db.prepare('SELECT installation_id FROM repositories WHERE id=12').get().installation_id,8);
    const partial=async path=>{
      if(new URL(path,'https://example.invalid').searchParams.get('page')==='1')return {repositories:Array.from({length:100},(_,index)=>({id:index+1,full_name:index===11?'old/repo':'old/other-'+index}))};
      throw new Error('Installation page two unavailable');
    };
    await assert.rejects(upsertInstalledRepository(db,7,{id:12,name:'repo',full_name:'old/repo',html_url:'https://example.invalid/old'},
      {api:partial,installToken:async()=> 'installation-token'}),/page two unavailable/);
    assert.equal(db.prepare('SELECT installation_id FROM repositories WHERE id=12').get().installation_id,8);
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
