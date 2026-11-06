// Offline independent witnesses for the existing sandbox PR #4 findings.
// Reads an immutable, inspected fixture revision; no API/model/network writes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha='d7fbf0ae810cdee283996e2db3ca691332a96396';
if(!process.argv[2])throw new Error('Usage: node benchmarks/verify-sandbox-precision.mjs <sandbox checkout>');
const repo=resolve(process.argv[2]);
const names=['audit-cursor','customer-ledger','half-open-range','hmac-verify','retry-backoff'];
const files=new Map(names.flatMap(name=>['src/lib/'+name+'.mjs','tests/'+name+'.test.mjs'])
  .map(path=>[path,execFileSync('git',['-C',repo,'show',sha+':'+path],{encoding:'utf8'})]));
const root=mkdtempSync(join(tmpdir(),'reviewforge-precision-'));
function variant(name,changes={}){
  const dir=join(root,name);
  for(const [path,text] of files){
    const target=join(dir,path);mkdirSync(dirname(target),{recursive:true});
    writeFileSync(target,changes[path]??text);
  }
  return dir;
}
function replaceOnce(path,before,after){
  const source=files.get(path);assert.equal(source.split(before).length,2);
  return source.replace(before,after);
}
function existingTests(dir){
  const result=spawnSync(process.execPath,['--test',...names.map(n=>'tests/'+n+'.test.mjs')],
    {cwd:dir,encoding:'utf8',timeout:15000});
  assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);
}
async function moduleAt(dir,name){return import(pathToFileURL(join(dir,'src/lib/'+name+'.mjs')).href);}

try{
  const original=variant('original');existingTests(original);
  const cursor=await moduleAt(original,'audit-cursor');
  const events=[{id:'a',createdAt:'2026-11-02T09:00:00Z'},
    {id:'b',createdAt:'2026-11-02T09:00:00Z'}];
  const first=cursor.pageAuditEvents(events,null,1);
  const next=cursor.pageAuditEvents(events,first[0],1);
  assert.deepEqual(first.map(e=>e.id),['a']);assert.deepEqual(next,[]);
  const repaired=variant('cursor-witness-fix',{'src/lib/audit-cursor.mjs':replaceOnce(
    'src/lib/audit-cursor.mjs','event.createdAt > cursor.createdAt',
    'event.createdAt.localeCompare(cursor.createdAt) > 0 ||\n'+
    '    (event.createdAt === cursor.createdAt && event.id.localeCompare(cursor.id) > 0)')});
  existingTests(repaired);
  assert.deepEqual((await moduleAt(repaired,'audit-cursor')).pageAuditEvents(events,first[0],1)
    .map(e=>e.id),['b']);

  const rangeMutant=variant('range-mutant',{'src/lib/half-open-range.mjs':replaceOnce(
    'src/lib/half-open-range.mjs','left.start < right.end && right.start < left.end',
    'right.start < left.end')});
  existingTests(rangeMutant);
  const later={start:10,end:20},earlier={start:0,end:10};
  assert.equal((await moduleAt(original,'half-open-range')).overlapsHalfOpen(later,earlier),false);
  assert.equal((await moduleAt(rangeMutant,'half-open-range')).overlapsHalfOpen(later,earlier),true);

  const retryMutant=variant('retry-mutant',{'src/lib/retry-backoff.mjs':replaceOnce(
    'src/lib/retry-backoff.mjs','Math.min(maximumMs, initialMs * 2 ** (attempt - 1))',
    'Math.min(30000, 1000 * 2 ** (attempt - 1))')});
  existingTests(retryMutant);
  assert.equal((await moduleAt(original,'retry-backoff')).cappedBackoffMs(2,250,700),500);
  assert.equal((await moduleAt(retryMutant,'retry-backoff')).cappedBackoffMs(2,250,700),2000);

  console.log(JSON.stringify({repository:'ibboabdoli-ai/reviewforge-sandbox',pr:4,headSha:sha,
    status:'offline-witnesses-passed',modelCalls:0,
    primaryRuntimeCases:{verified:1,total:1},supplementaryTestGaps:{verified:2,total:2},
    evidence:[{id:'cursor-tie',observedNextIds:[],expectedNextIds:['b'],witnessRepairPasses:true},
      {id:'range-reverse-negative',originalSuiteAcceptsMutant:true,witnessRejectsMutant:true},
      {id:'retry-custom-parameters',originalSuiteAcceptsMutant:true,witnessRejectsMutant:true}],
    limitations:['One selected historical PR; not population precision or recall.',
      'Two test gaps are supplementary, not two extra pre-registered runtime defects.',
      'No paired CodeRabbit result is available for this revision.',
      'The cursor repair is a local witness, not a model-generated or published fix.']},null,2));
}finally{
  // Delete only the dedicated temporary directory created by this process.
  assert.equal(dirname(resolve(root)),resolve(tmpdir()));
  assert.ok(resolve(root).startsWith(join(resolve(tmpdir()),'reviewforge-precision-')));
  rmSync(root,{recursive:true,force:true});
}
