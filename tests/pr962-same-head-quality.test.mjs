import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {scoreReviewQuality,scoreReviewQualitySameHead} from '../benchmarks/score-review.mjs';

const gold=JSON.parse(readFileSync(new URL('../benchmarks/proffera-pr962-gold.json',import.meta.url),'utf8'));
const sha='a83c202335eb602d6b1c5858a984eaa105f5d169';
const observed={repository:'ibboabdoli-ai/Proffera',pr:962,headSha:sha,findings:[]};

test('PR962 same-HEAD historical recall is honestly 0/2, not validated as improved',()=>{
 const scored=scoreReviewQualitySameHead(gold,observed);
 assert.equal(scored.referenceCount,2);
 assert.equal(scored.detected,0);
 assert.equal(scored.recall,0);
 assert.deepEqual(scored.missed,['duplicate-reviewed-commit-wakeup','missing-negative-duplicate-receipt-test']);
 assert.equal(gold.baseline.reviewId,10);
 assert.equal(gold.baseline.headSha,sha);
});

test('a wrong PR, repository or HEAD cannot inflate the strict benchmark score',()=>{
 const findings=[
  {path:'.github/workflows/proffera-final-gate-wakeup.yml',line:281,
   title:'Second Reviewed commit receipt marker',body:'A 41-hex duplicate receipt bypasses the count.'},
  {path:'tests/codex-review-receipt-gate.test.ts',line:94,
   title:'Missing negative test',body:'The fixture lacks a malformed second marker.'}
 ];
 const clean={...observed,findings};
 assert.equal(scoreReviewQualitySameHead(gold,clean).detected,2);
 // The legacy raw-array API cannot check identity; the strict API must.
 assert.equal(scoreReviewQuality(gold,findings).detected,2);
 for(const candidate of [
   {...clean,headSha:'b'.repeat(40)},
   {...clean,pr:961},
   {...clean,repository:'attacker/Proffera'},
   {...clean,headSha:undefined},
   {...clean,findings:undefined}
 ])assert.throws(()=>scoreReviewQualitySameHead(gold,candidate),/same PR and HEAD SHA/);
});

test('synthetic second malformed receipt exposes the previously missed gate pattern',()=>{
 // Standalone synthetic reproduction; does NOT execute or modify Proffera.
 const valid='Reviewed commit: '+'a'.repeat(10);
 const malformed='Reviewed commit: '+'b'.repeat(41);
 const body=valid+'\\n'+malformed;
 const acceptedPattern=/Reviewed commit:\\s*([0-9a-fA-F]{7,40})(?![0-9a-fA-F])/g;
 assert.equal([...body.matchAll(acceptedPattern)].length,1);
 assert.equal([...body.matchAll(/Reviewed commit:/g)].length,2);
 const unsafe= [...body.matchAll(acceptedPattern)].length===1;
 const corrected= [...body.matchAll(/Reviewed commit:/g)].length===1
   && [...body.matchAll(acceptedPattern)].length===1;
 assert.equal(unsafe,true);
 assert.equal(corrected,false);
});

test('offline PR962 references stay outside model prompts and review runtime',()=>{
 for(const p of ['../src/reviewer.mjs','../src/incremental-review.mjs',
   '../src/review-context.mjs','../src/review-skills.mjs']){
   const code=readFileSync(new URL(p,import.meta.url),'utf8');
   assert.doesNotMatch(code,/proffera-pr962-gold|scoreReviewQualitySameHead/);
 }
});
