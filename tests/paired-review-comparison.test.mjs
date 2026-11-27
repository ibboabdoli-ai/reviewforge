import test from 'node:test';
import assert from 'node:assert/strict';
import {comparePairedReviews} from '../benchmarks/compare-paired-reviews.mjs';

const headSha='a'.repeat(40);
function snapshot(tool,findings){return {tool,repository:'ibboabdoli-ai/Proffera',pr:123,
  headSha,status:'completed',coverage:{complete:true,eligible:2,analyzed:2,excluded:[]},
  findings,durationMs:1200,usage:{inputTokens:10,outputTokens:2,totalTokens:12}};}
function finding(id,severity='high'){return {id,path:'src/auth.ts',line:12,severity};}
const issue=(id,valid,rf,cr,severity='high')=>({id,valid,severity,
  evidence:'src/auth.ts:12 checked against the exact commit',
  reviewforgeFindingIds:rf,coderabbitFindingIds:cr});

test('only exact-head completed full reviews can produce quality comparisons',()=>{
  const rf=snapshot('reviewforge',[finding('r1')]);
  const cr=snapshot('coderabbit',[finding('c1')]);
  assert.throws(()=>comparePairedReviews(rf,{...cr,headSha:'b'.repeat(40)},{}),/exact HEAD/);
  assert.deepEqual(comparePairedReviews({...rf,status:'failed',error:'timeout'},cr,null).quality,null);
  assert.equal(comparePairedReviews({...rf,coverage:{...rf.coverage,analyzed:1}},cr,null).comparable,false);
  assert.throws(()=>comparePairedReviews(rf,cr,{issues:[]}),/every finding/);
});

test('code-adjudicated same-head comparison counts shared, missed, extra and false warnings',()=>{
  const rf=snapshot('reviewforge',[finding('r1'),finding('r2'),finding('r3')]);
  const cr=snapshot('coderabbit',[finding('c1'),finding('c2'),finding('c3')]);
  const report=comparePairedReviews(rf,cr,{issues:[
    issue('shared',true,['r1'],['c1']),
    issue('missed',true,[],['c2']),
    issue('extra',true,['r2'],[]),
    issue('rf-false',false,['r3'],[]),
    issue('cr-false',false,[],['c3'])]});
  assert.equal(report.comparable,true);
  assert.deepEqual(report.quality.sharedImportant,['shared']);
  assert.deepEqual(report.quality.missedImportant,['missed']);
  assert.deepEqual(report.quality.extraValid,['extra']);
  assert.deepEqual(report.quality.falseWarnings,{reviewforge:['rf-false'],coderabbit:['cr-false']});
  assert.equal(report.reviewforge.tokens.totalTokens,12);
  assert.equal(report.reviewforge.billedCost,null);
});

test('unassigned or reused findings cannot silently skew quality metrics',()=>{
  const rf=snapshot('reviewforge',[finding('r1'),finding('r2')]);
  const cr=snapshot('coderabbit',[finding('c1')]);
  assert.throws(()=>comparePairedReviews(rf,cr,{issues:[issue('shared',true,['r1'],['c1'])]}),/every finding/);
  assert.throws(()=>comparePairedReviews(rf,cr,{issues:[issue('one',true,['r1'],['c1']),
    issue('two',true,['r1','r2'],[])]}),/reused/);
});
