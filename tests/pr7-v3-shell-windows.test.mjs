import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
const windows=process.platform==='win32';
const wrapper=resolve(import.meta.dirname,'../benchmarks/pr7-v3-launch.ps1');
function make(t){
  const root=mkdtempSync(join(tmpdir(),'rf-v3-test-container-'));
  const target=join(root,'rf-v3-mock-fixedcase123');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  return target;
}
const invoke=(scenario,target)=>spawnSync('powershell.exe',[
  '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',wrapper,
  '-Mode','Mock','-MockScenario',scenario,'-MockEvidenceDirectory',target
],{encoding:'utf8',timeout:12000});
for(const [scenario,success] of [
  ['node-ok',true],['node-exit',false],
  ['node-timeout',false],['powershell-error',false]
]){
  test('PowerShell V3 safe journal captures '+scenario,{skip:!windows},t=>{
    const target=make(t);
    const r=invoke(scenario,target);
    assert.equal(r.status,success?0:1,r.stderr);
    const trace=join(target,'shell-stages.jsonl');
    assert.ok(existsSync(trace));
    const content=readFileSync(trace,'utf8');
    const stages=content.split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
    assert.ok(stages.some(x=>x.stage==='node_launching'));
    assert.equal(stages.at(-1).stage,success?
      'shell_terminal_success':'shell_terminal_failure');
    assert.ok(stages.every(x=>x.attempt==='rf-pr7-audited-once-20261111-v3'));
    assert.ok(stages.every(x=>!('key' in x || 'command' in x)));
    assert.ok(!content.includes('sk-proj-'));
    assert.ok(r.stdout.includes('RF_V3_OUTCOME='));
  });
}
test('PowerShell process kill leaves a persisted launch stage',{
  skip:!windows,timeout:17000
},async t=>{
  const target=make(t);
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive',
    '-ExecutionPolicy','Bypass','-File',wrapper,'-Mode','Mock',
    '-MockScenario','shell-pause','-MockEvidenceDirectory',target],
  {stdio:'ignore'});
  try{
    const file=join(target,'shell-stages.jsonl');
    let ready=false;
    for(let n=0;n<125;n++){
      if(existsSync(file)){
        try{
          const phases=readFileSync(file,'utf8');
          if(phases.includes('node_launching')){ready=true;break;}
        }catch{}
      }
      await new Promise(done=>setTimeout(done,40));
    }
    assert.equal(ready,true);
    assert.equal(child.kill(),true);
    await new Promise(done=>child.once('exit',done));
    const rows=readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(rows.some(x=>x.includes('node_launching')));
    assert.equal(rows.some(x=>x.includes('shell_terminal_success')),false);
  }finally{if(child.exitCode===null)child.kill();}
});
