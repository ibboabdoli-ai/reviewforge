import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('Vercel environment loads static assets and HTTPS APP_URL fallback',()=>{
  const p=spawnSync(process.execPath,['--input-type=module','-e',`import {config} from './src/config.mjs'; import handler from './api/index.mjs'; import {EventEmitter} from 'node:events';
    if(config.baseUrl!=='https://reviewforge-example.vercel.app')throw Error(config.baseUrl);
    const req=new EventEmitter();req.method='GET';req.url='/styles.css';req.headers={};
    const res={writeHead(code,headers){this.code=code;this.headers=headers;},end(body){if(this.code!==200||!String(body).includes('body'))throw Error('bad CSS');console.log('CSS OK');}};
    await handler(req,res);`],{encoding:'utf8',env:{...process.env,VERCEL:'1',VERCEL_URL:'reviewforge-example.vercel.app',APP_URL:'',NODE_ENV:'development',DEMO_MODE:'false'}});
  assert.equal(p.status,0,p.stderr||p.stdout);
  assert.match(p.stdout,/CSS OK/);
});
