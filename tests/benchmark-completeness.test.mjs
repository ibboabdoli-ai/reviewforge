import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreReviewQualitySameHead } from '../benchmarks/score-review.mjs';

const reference={repository:'test/sandbox',pr:1,headSha:'a'.repeat(40),cases:[{
  id:'known-defect',path:'src/app.js',lineMin:1,lineMax:1,anyEvidence:['defect']}]};
const snapshot={repository:reference.repository,pr:1,headSha:reference.headSha,
  status:'completed',coverage:{complete:true},findings:[{
    path:'src/app.js',line:1,title:'Known defect',body:'Synthetic evidence'}]};
test('same-SHA benchmark rejects incomplete, failed and unverified execution evidence',()=>{
  for(const candidate of [
    {...snapshot,status:'partial'}, {...snapshot,status:'failed'},
    {...snapshot,status:undefined}, {...snapshot,coverage:{complete:false}},
    {...snapshot,coverage:undefined}
  ])assert.throws(()=>scoreReviewQualitySameHead(reference,candidate),/completed.*coverage/i);
  assert.equal(scoreReviewQualitySameHead(reference,snapshot).detected,1);
});
