import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFilesForReview, planReviewBatches, addedLines } from '../src/reviewer.mjs';
import { analyzePullRequest } from '../src/pipeline.mjs';
const sha='a'.repeat(40);
const target={repository:'example/sandbox',number:1,headSha:sha,installationId:12};
function makeFiles(n){
 return Array.from({length:n},(_,i)=>({filename:i===n-1?'src/api/checkout.ts':`src/component-${i}.ts`,
   status:'modified',patch:`@@ -0,0 +1,1 @@\n+const x${i}=1;`}));
}
function mock(files){
 let posts=0,models=0;
 return {dependencies:{
  githubApi:async()=>({head:{sha},draft:false,state:'open'}),
  installationToken:async()=> 'fake',
  changedFiles:async()=> files,
  reviewWithAI:async()=>{models++;return {summary:'No issues seen in selected files.',findings:[]}},
  postReview:async()=>{posts++;return 'inline'}
 },calls:()=>({posts,models})};
}
test('small PR gets complete coverage and keeps live posting semantics',async()=>{
 const m=mock(makeFiles(3));
 const r=await analyzePullRequest({...target,postMode:'live'},m.dependencies);
 assert.equal(r.status,'completed');assert.equal(r.coverage.complete,true);
 assert.equal(m.calls().posts,1);
});
test('79-file PR is reviewed over 3 safe model batches',async()=>{
 const m=mock(makeFiles(79));
 const r=await analyzePullRequest({...target,postMode:'live'},m.dependencies);
 assert.equal(r.status,'completed');assert.equal(r.coverage.reviewed,79);
 assert.equal(r.coverage.reviewable,79);assert.equal(r.coverage.batches,3);
 assert.equal(r.coverage.complete,true);
 assert.deepEqual(m.calls(),{posts:1,models:3});
});
test('multi-batch job stays offline when global daily budget cannot cover full plan',async()=>{
 const m=mock(makeFiles(79));
 const r=await analyzePullRequest({...target,postMode:'live'},{
   ...m.dependencies,
   reserveModelCalls:async count=>({allowed:false,reason:count>2?'requires-higher-cap':'daily-used'})
 });
 assert.equal(r.status,'partial');assert.equal(r.posted,0);
 assert.match(r.summary,/configured daily allowance/);
 assert.deepEqual(m.calls(),{posts:0,models:0});
});
test('temporary daily exhaustion causes a safe defer without model calls',async()=>{
 const m=mock(makeFiles(3));
 const r=await analyzePullRequest({...target,postMode:'live'},{
   ...m.dependencies,
   reserveModelCalls:async()=>({allowed:false,reason:'daily-used'})
 });
 assert.equal(r.status,'deferred');assert.equal(r.posted,0);
 assert.deepEqual(m.calls(),{posts:0,models:0});
});
test('oversized patch never gets truncated and cannot produce clean verdict',async()=>{
 const big='@@ -0,0 +1,1 @@\n+'+'x'.repeat(6600);
 const m=mock([{filename:'src/api/payments.ts',status:'modified',patch:big}]);
 const r=await analyzePullRequest({...target,postMode:'live'},m.dependencies);
 assert.equal(r.status,'partial');assert.equal(r.coverage.oversized,1);
 assert.deepEqual(m.calls(),{posts:0,models:0});
});
test('unknown or unavailable patches are disclosed, not silently skipped',async()=>{
 const m=mock([{filename:'src/api/auth.ts',status:'modified'},{filename:'src/lib/safe.ts',status:'modified',patch:'@@ -0,0 +1,1 @@\n+const x=1;'}]);
 const r=await analyzePullRequest({...target,postMode:'dry-run'},m.dependencies);
 assert.equal(r.status,'partial');assert.equal(r.coverage.missingPatch,1);
 assert.equal(r.coverage.reviewed,1);
 assert.deepEqual(m.calls(),{posts:0,models:1});
});
test('security sensitive files prioritized over components in bounded review',()=>{
 const selection=selectFilesForReview(makeFiles(50));
 assert.equal(selection.files[0].filename,'src/api/checkout.ts');
 assert.equal(selection.coverage.limited,15);
 assert.equal(selection.coverage.complete,false);
});

test('large unified hunk is split with correct GitHub new-line anchors',()=>{
 const lines=Array.from({length:800},(_,i)=>'+const item'+i+'='+i+';').join('\n');
 const {batches,coverage}=planReviewBatches([{filename:'src/api/security.ts',status:'modified',patch:'@@ -0,0 +1,800 @@\n'+lines}]);
 assert.equal(coverage.complete,true);
 assert.ok(coverage.segments>1);
 const all=batches.flat().filter(x=>x.filename==='src/api/security.ts');
 assert.ok(all.every(x=>x.patch.length<=6500));
 const covered=new Set(all.flatMap(x=>[...addedLines(x.patch)]));
 assert.equal(covered.size,800);
 assert.ok(covered.has(1));assert.ok(covered.has(800));
});
test('too many reviewable files disclose incomplete coverage without posting',async()=>{
 const m=mock(makeFiles(180));
 const r=await analyzePullRequest({...target,postMode:'live'},m.dependencies);
 assert.equal(r.status,'partial');assert.equal(r.posted,0);
 assert.ok(r.coverage.limited>0);assert.match(r.summary,/INCOMPLETE REVIEW/);
});
test('reviews across batches deduplicate findings and cap published comments',async()=>{
 const files=makeFiles(48);
 const m=mock(files);
 const r=await analyzePullRequest({...target,postMode:'dry-run'},{
  ...m.dependencies,reviewWithAI:async batch=>({
   summary:'Evidence-based review',
   findings:batch.slice(0,10).map(f=>({path:f.filename,line:1,severity:'high',
      category:'correctness',title:'Specific regression',body:'Concrete unsafe behavior requiring a guard.',confidence:.93}))
  })
 });
 assert.equal(r.status,'completed');assert.equal(r.findings.length,8);assert.equal(r.posted,0);
});
