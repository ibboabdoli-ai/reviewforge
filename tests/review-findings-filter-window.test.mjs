import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings } from '../src/reviewer.mjs';

const filename='src/review-gate.ts';
const patch='@@ -1,1 +1,2 @@\n unchanged\n+rejectEditedReceipt();';
const valid={
  path:filename,line:2,severity:'high',category:'correctness',
  title:'Reject edited review receipt',
  body:'A modified review receipt must not be trusted as current approval.',
  confidence:0.95
};

test('a valid later finding survives a bounded window of malformed model suggestions',()=>{
  // Synthetic, no model/API/network: the previous .slice(0,12) took the first
  // 12 candidates BEFORE validation, and silently dropped the valid 13th.
  const malformed=Array.from({length:12},(_,i)=>({...valid,line:900+i}));
  assert.deepEqual(validateFindings([...malformed,valid],[{filename,patch}]),[
    valid
  ]);
});

test('finding scan remains bounded and output stays capped at eight',()=>{
  const malformed=Array.from({length:64},(_,i)=>({...valid,line:900+i}));
  // Never scan arbitrarily large or untrusted model output.
  assert.equal(validateFindings([...malformed,valid],[{filename,patch}]).length,0);
  const tenLines=Array.from({length:10},(_,i)=>'+'+'gateCheck'+i+'();');
  const tenPatch='@@ -0,0 +1,10 @@\n'+tenLines.join('\n');
  const tenFindings=Array.from({length:10},(_,i)=>({...valid,line:i+1}));
  const accepted=validateFindings(tenFindings,[{filename,patch:tenPatch}]);
  assert.equal(accepted.length,8);
  assert.deepEqual(accepted.map(f=>f.line),[1,2,3,4,5,6,7,8]);
});

test('a later critical finding must not be crowded out by eight low-risk suggestions',()=>{
  // Synthetic validation only: ranking happens after checking anchors and
  // before the existing eight-finding output cap; no model/API call.
  const lines=Array.from({length:9},(_,i)=>'+guard'+i+'();');
  const patch='@@ -0,0 +1,9 @@\\n'.replace('\\n','\n')+lines.join('\n');
  const raw=Array.from({length:9},(_,i)=>({
    ...valid,line:i+1,severity:i===8?'critical':'low',
    title:'Independent issue '+i,body:'Separate defect on changed line '+(i+1)
  }));
  const accepted=validateFindings(raw,[{filename,patch}]);
  assert.equal(accepted.length,8);
  assert.equal(accepted.filter(f=>f.severity==='critical').length,1);
  assert.equal(accepted.filter(f=>f.severity==='low').length,7);
});

test('duplicate anchors keep the highest-severity validated finding before output cap',()=>{
  // Repro: a low finding on one changed line previously shadowed a critical
  // finding on that SAME line before the severity sorting pass.
  const twoLinePatch='@@ -0,0 +1,2 @@\n+guard();\n+verify();';
  const low={...valid,line:1,severity:'low',title:'Early minor issue'};
  const critical={...valid,line:1,severity:'critical',title:'Later critical bypass'};
  const high={...valid,line:2,severity:'high',title:'Different anchor'};
  const sameSeverity={...valid,line:2,severity:'high',title:'Same-severity duplicate'};
  const actual=validateFindings([low,high,critical,sameSeverity],[{filename,patch:twoLinePatch}]);
  assert.deepEqual(actual.map(f=>[f.line,f.severity,f.title]),[
    [1,'critical','Later critical bypass'],
    [2,'high','Different anchor']
  ]);
});
