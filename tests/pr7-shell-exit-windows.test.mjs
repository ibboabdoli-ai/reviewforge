import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const isWindows=process.platform==='win32';
const wrapper=resolve(import.meta.dirname,'../benchmarks/pr7-shell-exit-mock.ps1');
const make=t=>{
  const container=mkdtempSync(join(tmpdir(),'rf-shell-test-root-'));
  const output=join(container,'rf-shell-mock-case1234');
  t.after(()=>rmSync(container,{recursive:true,force:true}));
  return {output};
};
function invoke(output,scenario){
  return spawnSync('powershell.exe',['-NoProfile','-NonInteractive',
    '-ExecutionPolicy','Bypass','-File',wrapper,
    '-Scenario',scenario,'-EvidenceDirectory',output],
    {encoding:'utf8',timeout:11000});
}
for(const [scenario,status,code] of [
  ['node-ok','completed_mock_only',0],
  ['node-exit','error_mock_only',1],
  ['node-stderr-exit','error_mock_only',1],
  ['powershell-error','error_mock_only',1]
]){
  test('mock shell preserves outcome on '+scenario,{skip:!isWindows},t=>{
    const {output}=make(t);
    const result=invoke(output,scenario);
    assert.equal(result.status,code,result.stderr);
    assert.equal(existsSync(join(output,'prelaunch.json')),true);
    assert.equal(existsSync(join(output,'terminal.json')),true);
    const saved=JSON.parse(readFileSync(join(output,'terminal.json'),'utf8'));
    assert.equal(saved.mode,'OFFLINE_MOCK');
    assert.equal(saved.status,status);
    assert.equal(saved.providerRequests,0);
    assert.ok(result.stdout.includes('MOCK_TERMINAL_STATUS='+status));
    assert.ok(result.stdout.includes('MOCK_EVIDENCE_PATH='));
    assert.ok(!JSON.stringify(saved).includes('sk-proj-'));
  });
}
test('force-terminated mock PowerShell leaves only the prelaunch marker',{
  skip:!isWindows,timeout:15000
},async t=>{
  const {output}=make(t);
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive',
    '-ExecutionPolicy','Bypass','-File',wrapper,
    '-Scenario','powershell-pause','-EvidenceDirectory',output],
    {stdio:'ignore'});
  let killed=false;
  try{
    const pre=join(output,'prelaunch.json');
    for(let attempt=0;attempt<100&&!existsSync(pre);attempt++){
      await new Promise(r=>setTimeout(r,40));
    }
    assert.equal(existsSync(pre),true,'Synthetic process did not create its prelaunch marker');
    killed=child.kill();
    assert.equal(killed,true);
    await new Promise(resolve=>child.once('exit',resolve));
    assert.equal(existsSync(join(output,'terminal.json')),false);
    const marker=JSON.parse(readFileSync(pre,'utf8'));
    assert.equal(marker.stage,'powershell_entered');
    assert.equal(marker.providerRequests,0);
  }finally{
    if(!killed)child.kill();
  }
});
