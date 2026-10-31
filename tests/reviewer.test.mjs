import test from 'node:test';
import assert from 'node:assert/strict';
import { addedLines,safeFiles,selectFilesForReview,coverageSummary,validateFindings,localDemoReview } from '../src/reviewer.mjs';

const patch='@@ -7,4 +7,5 @@\n context\n-oldCall();\n+safeCall();\n+console.log(secret);\n last\n';
test('Unified diff parser returns only new-file changed line numbers',()=>{
  assert.deepEqual([...addedLines(patch)],[8,9]);
  assert.ok(!addedLines(patch).has(7));
});
test('Review findings must be anchored to added lines with high confidence',()=>{
  const files=[{filename:'src/test.ts',patch}];
  const base={path:'src/test.ts',line:8,severity:'high',category:'security',title:'An issue',body:'Actionable regression description',confidence:.9};
  const findings=validateFindings([base,{...base,line:7},{...base,path:'other.ts'},{...base,confidence:.1},{...base,line:8}],files);
  assert.equal(findings.length,1);assert.equal(findings[0].line,8);
});
test('Large diffs and lockfiles are limited',()=>{
  const files=[{filename:'package-lock.json',patch:'@@ -1 +1 @@\n+a'}, {filename:'src/app.ts',patch:'x'.repeat(70000)}];
  const selected=selectFilesForReview(files);
  assert.equal(selected.files.length,0);
  assert.equal(selected.coverage.oversized,1);
  assert.equal(selected.coverage.excluded,1);
  assert.equal(selected.coverage.complete,false);
  assert.match(coverageSummary(selected.coverage),/INCOMPLETE REVIEW/);
});
test('Demo scanner is explicitly labeled non-AI',()=>{
  const result=localDemoReview('@@ -1 +1 @@\n+eval(code)\n+console.log(password)');
  assert.equal(result.findings.length,2);assert.match(result.summary,/NOT an AI review/);
});
