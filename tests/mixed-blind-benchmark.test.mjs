import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreMixedBlindReview,gold} from '../benchmarks/score-mixed-blind.mjs';

const sample={
 repository:gold.targetRepository,pr_number:gold.targetPr,
 head_sha:gold.targetHeadSha,status:'completed',posted:0,
 findings:[
  {path:'src/lib/ticket-capacity.mjs',line:8,
   title:'Exact capacity reservation incorrectly refused',
   body:'At the equal boundary, >= rejects tickets exactly filling capacity.'},
  {path:'src/lib/delivery-once.mjs',line:10,
   title:'Delivery retries can be lost',
   body:'Seen id is added before publish; after a rejected publish retry is a duplicate.'},
  {path:'src/lib/monthly-summary.mjs',line:9,
   title:'Monthly summary ignores year',
   body:'The filter checks month, not year, and sums previous-year charges.'}
 ]
};
test('pre-registered mixed benchmark has three distinct behavior defects and two clean controls',()=>{
 assert.equal(gold.cases.length,3);
 assert.equal(gold.cleanControls.length,2);
 assert.equal(gold.targetHeadSha.length,40);
 assert.equal(gold.targetPr,3);
});
test('exact SHA offline fixture matches three references without a real model call',()=>{
 const score=scoreMixedBlindReview(sample);
 assert.equal(score.primaryMatched,3);
 assert.equal(score.primaryMissed.length,0);
 assert.equal(score.cleanControlFindingCandidates.length,0);
 assert.equal(score.status,'MANUAL_TRIAGE_REQUIRED');
});
test('findings on clean control are not automatically called false positives',()=>{
 const additional={path:'src/lib/task-lock.mjs',line:8,title:'Investigate lock handling',
   body:'This needs manual review and may not be a bug.'};
 const score=scoreMixedBlindReview({...sample,findings:[...sample.findings,additional]});
 assert.equal(score.primaryMatched,3);
 assert.equal(score.cleanControlFindingCandidates.length,1);
 assert.equal(score.unscoredFindings,1);
});
test('wrong commit or posted review is refused by scorer',()=>{
 assert.throws(()=>scoreMixedBlindReview({...sample,head_sha:'0'.repeat(40)}),/exact registered/);
 assert.throws(()=>scoreMixedBlindReview({...sample,posted:1}),/no-post/);
});
test('reference answers never appear in production reviewer source',()=>{
 for(const name of ['reviewer.mjs','review-context.mjs','incremental-review.mjs','review-skills.mjs','review-method.mjs']){
  const code=readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
  assert.doesNotMatch(code,/sandbox-mixed-blind-20261102|score-mixed-blind|exact-capacity-rejected/);
 }
});
