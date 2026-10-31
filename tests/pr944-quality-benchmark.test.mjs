import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreReviewQuality} from '../benchmarks/score-review.mjs';

const gold=JSON.parse(readFileSync(new URL('../benchmarks/proffera-pr944-gold.json',import.meta.url),'utf8'));
const modelFindings=[
 {path:'src/lib/company-directory-scb-afr-v1.test.ts',line:151,
  title:'Make legal-entity rejection test reach company validation',
  body:'The second mocked fetch returns undefined before companyRecord validation, leaving an early exit.'},
 {path:'src/lib/company-directory-scb-afr-v1.test.ts',line:160,
  title:'Assert that the error excludes the API key',
  body:'A configured API key leak could pass the weak HTTP 429 check; assert the key is absent.'}
];

test('PR944 accepted, independently checked shadow findings map to exactly 2 reference cases',()=>{
 assert.equal(gold.pr,944);
 assert.equal(gold.cases.length,2);
 assert.equal(gold.observed.reviewId,6);
 assert.equal(gold.observed.acceptedFindingsCount,2);
 assert.equal(gold.observed.posted,0);
 const score=scoreReviewQuality(gold,modelFindings);
 assert.equal(score.detected,2);
 assert.equal(score.referenceCount,2);
 assert.equal(score.recall,1);
 assert.equal(score.unmatchedFindings,0);
});
test('PR944 poor style comments, invalid anchors, and a single duplicated issue do not manufacture 2/2',()=>{
 const poor=scoreReviewQuality(gold,[
  {path:gold.cases[0].path,line:151,title:'Spacing',body:'Format this test.'},
  {path:gold.cases[1].path,line:99,title:'API key',body:'Key should not leak.'}
 ]);
 assert.equal(poor.detected,0);
 const duplicate=scoreReviewQuality(gold,[modelFindings[0],modelFindings[0]]);
 assert.equal(duplicate.detected,1);
 assert.deepEqual(duplicate.missed,['api-key-negative-assertion']);
});
test('PR944 benchmark is not referenced by runtime reviewer or its trusted instructions',()=>{
 for(const file of ['../src/reviewer.mjs','../src/review-context.mjs',
   '../src/incremental-review.mjs','../src/review-skills.mjs','../src/review-method.mjs']){
  const source=readFileSync(new URL(file,import.meta.url),'utf8');
  assert.doesNotMatch(source,/proffera-pr944-gold|pr944-mutation-demonstrations/i);
  assert.doesNotMatch(source,/scoreReviewQuality/);
 }
});
