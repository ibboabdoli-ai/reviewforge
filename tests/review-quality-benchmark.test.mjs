import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreReviewQuality} from '../benchmarks/score-review.mjs';
const gold=JSON.parse(readFileSync(new URL('../benchmarks/proffera-pr953-gold.json',import.meta.url),'utf8'));
test('PR953 baseline honestly records zero matched reference findings',()=>{
 const result=scoreReviewQuality(gold,[]);
 assert.equal(result.detected,0);
 assert.equal(result.referenceCount,3);
 assert.equal(result.recall,0);
 assert.deepEqual(result.missed,['entity-scoping','retry-unit-test','existing-profile-branch']);
});
test('quality scorer distinguishes each of three references without feeding them to a model',()=>{
 const findings=[
  {path:'src/lib/company-directory-detail-validation.ts',line:21,title:'Wrong organization identity',body:'Scope error collection to the requested record.'},
  {path:'tests/company-directory-discovery-not-found-backoff.test.ts',line:58,title:'Unit not checked',body:'Assert the SQL minutes interval in the test.'},
  {path:'tests/company-directory-discovery-not-found-backoff.test.ts',line:54,title:'Missing existing-profile pilot cases',body:'Test both requeue branches with a stored profile.'}
 ];
 const r=scoreReviewQuality(gold,findings);
 assert.equal(r.detected,3);
 assert.equal(r.recall,1);
 assert.equal(r.unmatchedFindings,0);
});
test('unrelated low-quality comments are not counted as matched findings',()=>{
 const results=scoreReviewQuality(gold,[
  {path:'src/lib/company-directory-detail-validation.ts',line:21,title:'Please format this line',body:'Looks nicer.'},
  {path:'tests/company-directory-discovery-not-found-backoff.test.ts',line:99,title:'Add prettier',body:'Use better style.'}
 ]);
 assert.equal(results.detected,0);
 assert.equal(results.unmatchedFindings,2);
});
test('benchmark gold data stays separate from all model prompt modules',()=>{
 const reviewer=readFileSync(new URL('../src/reviewer.mjs',import.meta.url),'utf8');
 const context=readFileSync(new URL('../src/review-context.mjs',import.meta.url),'utf8');
 const pipeline=readFileSync(new URL('../src/incremental-review.mjs',import.meta.url),'utf8');
 for(const code of [reviewer,context,pipeline]){
   assert.doesNotMatch(code,/proffera-pr953-gold/);
   assert.doesNotMatch(code,/scoreReviewQuality/);
 }
});
