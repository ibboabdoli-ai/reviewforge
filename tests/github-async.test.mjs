import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {syncInstallations,authorizedRepositoryIds} from '../src/github.mjs';
import {reviewsPage,reviewDetail,reposPage} from '../src/ui.mjs';

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
      throw new Error('Unexpected GitHub API request');
    };
    const bob={id:2,github_id:202,login:'bob'};
    const repositoryAccess=(db,user)=>authorizedRepositoryIds(db,user,{api,userToken:async()=> 'bob-token'});
    assert.deepEqual([...await repositoryAccess(db,bob)],[]);
    assert.doesNotMatch(await reposPage(db,bob,'csrf',{repositoryAccess}),/old-org\/repo/);
    assert.equal(await reviewDetail(db,bob,'csrf',41,{repositoryAccess}),null);
    await syncInstallations(db,bob,{api,userToken:async()=> 'bob-token'});
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
