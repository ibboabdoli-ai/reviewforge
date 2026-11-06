import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openDatabase} from '../src/db.mjs';
import {syncInstallations} from '../src/github.mjs';

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
