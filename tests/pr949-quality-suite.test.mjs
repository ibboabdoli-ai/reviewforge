import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreReviewQuality} from '../benchmarks/score-review.mjs';
import {loadArchivedSuite,scoreObservedSuite,OBSERVED_PRS} from '../benchmarks/score-suite.mjs';

const gold=JSON.parse(readFileSync(new URL('../benchmarks/proffera-pr949-gold.json',import.meta.url),'utf8'));
const archive=JSON.parse(readFileSync(new URL('../benchmarks/observed-reviewforge.json',import.meta.url),'utf8'));
const historical=archive.entries.find(r=>r.pr===949);
const suiteReferences=Object.fromEntries(OBSERVED_PRS.map(pr=>[
 pr,JSON.parse(readFileSync(new URL('../benchmarks/proffera-pr'+pr+'-gold.json',import.meta.url),'utf8'))
]));

test('PR949 historical review finds one independently verified bug out of six scoped reference cases',()=>{
 assert.equal(gold.cases.length,6);
 assert.equal(gold.unscored.length,2);
 assert.equal(gold.observed.reviewId,5);
 assert.equal(historical.headSha,gold.headSha);
 const result=scoreReviewQuality(gold,historical.findings);
 assert.equal(result.referenceCount,6);
 assert.equal(result.detected,1);
 assert.equal(result.recall,1/6);
 assert.equal(result.unmatchedFindings,0);
 assert.deepEqual(result.missed,[
   'transient-storage-write','fresh-session-randomness','no-crypto-event-guard',
   'rate-limit-conflict-real-db','rendered-contact-actions'
 ]);
});
test('PR949 benchmark requires multiple facets, not a word at a nearby source line',()=>{
 const vague=gold.cases.map(c=>({
   path:c.path,line:c.lineMin,title:'General review comment',
   body:'Check storage and session, SQL and mock, email and mailto.'
 }));
 const score=scoreReviewQuality(gold,vague);
 assert.equal(score.detected,0);
 assert.equal(score.unmatchedFindings,vague.length);
 const relevant=[
  {path:'tests/public-business-session-key.test.ts',line:10,title:'Test fresh random sessions',
   body:'The same sessionStorage is reused. A constant getRandomValues byte source can pass because different keys are not checked.'},
  {path:'tests/public-business-session-key.test.ts',line:27,title:'No crypto event path is untested',
   body:'With no crypto, only sessionKey is tested; removing the sendEvent fetch guard would be unnoticed.'},
  {path:'tests/public-form-protection-fingerprint-continuity.test.ts',line:51,
   title:'Mocked SQL skips ON CONFLICT',body:'The SQL mock never executes the database attempts counter update.'}
 ];
 const result=scoreReviewQuality(gold,relevant);
 assert.equal(result.detected,3);
 assert.equal(result.unmatchedFindings,0);
});
test('all historical benchmarks are SHA-matched, distinct and retain different model policies',()=>{
 const score=loadArchivedSuite();
 assert.equal(score.status,'retrospective-only');
 assert.equal(score.prs,3);
 assert.deepEqual(score.rows.map(r=>r.pr),[944,949,953]);
 assert.deepEqual(score.rows.map(r=>r.matchedCases),[2,1,0]);
 assert.deepEqual(score.rows.map(r=>r.referenceCases),[2,6,3]);
 assert.equal(score.totals.referenceCases,11);
 assert.equal(score.totals.matchedCases,3);
 assert.equal(score.totals.acceptedFindings,3);
 assert.equal(score.totals.unmatchedAcceptedFindings,0);
 assert.notEqual(score.rows[0].method,score.rows[2].method);
 assert.match(score.scope,/NOT an estimated production recall/);
});
test('offline suite rejects SHA mismatch, duplicate review IDs and non-shadow records',()=>{
 const copy=()=>structuredClone(archive);
 const wrongSha=copy();wrongSha.entries[0].headSha='0'.repeat(40);
 assert.throws(()=>scoreObservedSuite(suiteReferences,wrongSha),/SHA-mismatched/);
 const duplicate=copy();duplicate.entries[1].reviewId=duplicate.entries[0].reviewId;
 assert.throws(()=>scoreObservedSuite(suiteReferences,duplicate),/duplicate/);
 const notShadow=copy();notShadow.entries[0].posted=1;
 assert.throws(()=>scoreObservedSuite(suiteReferences,notShadow),/Incomplete/);
});
test('archived findings and golden answers are never loaded in runtime prompt paths',()=>{
 for(const relative of ['../src/reviewer.mjs','../src/review-method.mjs',
   '../src/review-context.mjs','../src/review-skills.mjs','../src/incremental-review.mjs']){
   const runtime=readFileSync(new URL(relative,import.meta.url),'utf8');
   assert.doesNotMatch(runtime,/observed-reviewforge|proffera-pr949-gold|score-suite/i);
   assert.doesNotMatch(runtime,/benchmarks\/|scoreReviewQuality/);
 }
});
