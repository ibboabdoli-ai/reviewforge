import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { reference, scorePrecisionReview } from '../benchmarks/score-precision.mjs';

const base = {
  repository: reference.targetRepository, pr_number: reference.targetPr,
  head_sha: reference.targetHeadSha, status: 'completed', posted: 0,
  findings: []
};
test('answers are pre-registered at the exact PR commit and cover four healthy modules', () => {
  assert.equal(reference.targetPr, 4);
  assert.equal(reference.targetHeadSha, 'a54cf27eaddc0e9d54d1baad1fd660ede072cd09');
  assert.equal(reference.primaryCases.length, 1);
  assert.equal(reference.cleanControls.length, 4);
  assert.equal(reference.primaryCases[0].lineMin, 15);
});
test('specific timestamp-tie finding matches, but generic pagination feedback does not', () => {
  const good = {
    path:'src/lib/audit-cursor.mjs', line:15, title:'Timestamp tie skips a record',
    body:'The cursor filter ignores the id on an identical timestamp; a same-time audit entry is omitted.'
  };
  const vague = {...good, title:'Pagination might be improved', body:'Use better code formatting.'};
  assert.equal(scorePrecisionReview({...base,findings:[good]}).primaryMatched,1);
  assert.equal(scorePrecisionReview({...base,findings:[vague]}).primaryMatched,0);
});
test('clean-control finding is presented for triage, not automatically a false positive', () => {
  const finding={path:'src/lib/half-open-range.mjs',line:6,
    title:'Check range assumptions',body:'Need to verify caller uses half-open ranges.'};
  const score=scorePrecisionReview({...base,findings:[finding]});
  assert.equal(score.primaryMatched,0);
  assert.equal(score.cleanControlCandidateCount,1);
  assert.equal(score.unscoredFindings,1);
  assert.match(score.interpretation,/not automatically false positives/);
});
test('wrong HEAD, wrong PR, or posted comments cannot be scored', () => {
  assert.throws(()=>scorePrecisionReview({...base,head_sha:'0'.repeat(40)}),/exact-SHA/);
  assert.throws(()=>scorePrecisionReview({...base,pr_number:10}),/exact-SHA/);
  assert.throws(()=>scorePrecisionReview({...base,posted:1}),/no-post/);
});
test('benchmark answers remain outside runtime model input modules', () => {
  for(const path of ['reviewer.mjs','review-context.mjs','review-skills.mjs','review-method.mjs','incremental-review.mjs']){
    const source=readFileSync(new URL('../src/'+path,import.meta.url),'utf8');
    assert.doesNotMatch(source,/sandbox-precision-20261102|score-precision|audit-cursor-timestamp-tie/);
    assert.doesNotMatch(source,/benchmarks\//);
  }
});
