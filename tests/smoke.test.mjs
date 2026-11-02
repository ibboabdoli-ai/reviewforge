import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
test('HTTP landing, isolated demo, CSRF, diff review, and security headers',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'reviewforge-http-'));
  const port=24000+Math.floor(Math.random()*15000),origin=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.mjs'],{cwd:root,
    env:{...process.env,PORT:String(port),APP_URL:origin,DB_PATH:join(dir,'db.sqlite'),SESSION_SECRET:randomBytes(32).toString('hex'),DEMO_MODE:'true',GITHUB_CLIENT_ID:'',GITHUB_CLIENT_SECRET:'',GITHUB_APP_ID:'',GITHUB_WEBHOOK_SECRET:'',OPENAI_API_KEY:'',NODE_ENV:'development'},stdio:'ignore'});
  try{
    let ready=false;
    for(let i=0;i<35;i++){
      if(child.exitCode!==null)throw new Error('Server exited before responding');
      await new Promise(r=>setTimeout(r,100));
      try {if((await fetch(origin+'/healthz')).status===200){ready=true;break;}}catch{}
    }
    assert.ok(ready,'Server never became ready');
    const landing=await fetch(origin+'/');assert.equal(landing.status,200);
    assert.match(await landing.text(),/Ship faster/);
    assert.match(landing.headers.get('content-security-policy'),/frame-ancestors/);
    const demo=await fetch(origin+'/demo',{redirect:'manual'});assert.equal(demo.status,303);
    const session=demo.headers.get('set-cookie').split(';')[0];
    assert.ok(session.startsWith('sid='));
    const board=await fetch(origin+'/dashboard',{headers:{Cookie:session}});assert.equal(board.status,200);
    const html=await board.text();assert.match(html,/Recent code reviews/);
    const playground=await fetch(origin+'/demo/analyze',{headers:{Cookie:session}});const page=await playground.text();
    const csrf=page.match(/name="csrf" value="([a-f0-9]+)"/)[1];
    const invalid=await fetch(origin+'/demo/analyze',{method:'POST',headers:{Cookie:session,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:'invalid',title:'Test',diff:'+eval(x)'})});
    assert.equal(invalid.status,403);
    const checked=await fetch(origin+'/demo/analyze',{method:'POST',redirect:'manual',headers:{Cookie:session,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,title:'Test',diff:'@@ -1 +1 @@\n+eval(x)'})});
    assert.equal(checked.status,303);
    const review=await fetch(origin+checked.headers.get('location'),{headers:{Cookie:session}});assert.equal(review.status,200);
    assert.match(await review.text(),/Use of eval detected/);
  }finally{child.kill('SIGTERM');rmSync(dir,{force:true,recursive:true});}
});
