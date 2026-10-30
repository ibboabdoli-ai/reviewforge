import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {retryState} from '../src/queue-policy.mjs';

test('bounded retry policy marks third failure terminal',()=>{
  const now=1000000;
  assert.deepEqual(retryState(1,now),{failed:false,nextAttemptAt:now+60000});
  assert.deepEqual(retryState(2,now),{failed:false,nextAttemptAt:now+120000});
  assert.deepEqual(retryState(3,now),{failed:true,nextAttemptAt:now});
  assert.throws(()=>retryState(0,now),/Invalid attempt/);
});
test('cron and manual worker endpoints authenticate and record safe heartbeats',()=>{
  const tmp=mkdtempSync(join(tmpdir(),'rf-cron-check-'));
  const cronSecret='cron-test-auth-header-with-more-than-32-chars';
  const workerSecret='worker-test-auth-header-with-more-than-32-chars';
  const source=`
    import handler from './src/server.mjs';
    import {openDatabase} from './src/db.mjs';
    import {EventEmitter} from 'node:events';
    async function invoke(method,header){
      const req=new EventEmitter();
      req.method=method;req.url='/internal/process-queue';
      req.headers=header?{authorization:header}:{};
      let status=0,body='';
      const res={writeHead(code){status=code;},end(data){body=String(data||'');}};
      await handler(req,res);
      return {status,body};
    }
    const denied=await invoke('GET');
    const valid=await invoke('GET','Bearer '+process.env.CRON_SECRET);
    const wrongMethod=await invoke('POST','Bearer '+process.env.CRON_SECRET);
    const manual=await invoke('POST','Bearer '+process.env.WORKER_SECRET);
    const db=openDatabase(process.env.DB_PATH);
    const rows=db.prepare('SELECT source,last_result,runs FROM scheduler_heartbeats ORDER BY source').all();
    db.close();
    if(denied.status!==403||wrongMethod.status!==403||valid.status!==200||manual.status!==200)throw Error(JSON.stringify({denied,wrongMethod,valid,manual}));
    if(JSON.parse(valid.body).status!=='disabled')throw Error('False processed result');
    if(rows.length!==2||rows.some(r=>r.last_result!=='disabled'||r.runs!==1))throw Error(JSON.stringify(rows));
    console.log('CRON_AUTH_AND_HEARTBEATS_OK');
  `;
  try{
    const res=spawnSync(process.execPath,['--input-type=module','-e',source],{
      cwd:process.cwd(),encoding:'utf8',
      env:{...process.env,DB_PATH:join(tmp,'cron.sqlite'),DATABASE_URL:'',NODE_ENV:'development',VERCEL:'1',DEMO_MODE:'false',AI_REVIEW_ENABLED:'false',CRON_SECRET:cronSecret,WORKER_SECRET:workerSecret}
    });
    assert.equal(res.status,0,res.stderr||res.stdout);
    assert.match(res.stdout,/CRON_AUTH_AND_HEARTBEATS_OK/);
  }finally{rmSync(tmp,{recursive:true,force:true});}
});
