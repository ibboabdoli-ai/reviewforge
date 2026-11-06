import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {resolve,parse} from 'node:path';
const sandbox=resolve(import.meta.dirname,'../../reviewforge-sandbox');
test('witness cleanup supports a drive-relative Windows TEMP',{
  skip:process.platform!=='win32'||!existsSync(sandbox),timeout:30000
},()=>{
  const root=resolve(import.meta.dirname,'..');
  const drive=parse(root).root.slice(0,2);
  const result=spawnSync(process.execPath,['benchmarks/verify-sandbox-precision.mjs',sandbox],{
    cwd:root,env:{...process.env,TEMP:drive,TMP:drive},encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.error?.message||result.stderr);
  assert.equal(JSON.parse(result.stdout).status,'offline-witnesses-passed');
});
