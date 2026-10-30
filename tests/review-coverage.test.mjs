import test from 'node:test';
import assert from 'node:assert/strict';
import { selectFilesForReview } from '../src/reviewer.mjs';
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
test('CodeRabbit-scale 79-file PR is never silently labeled clean or posted',async()=>{
 const m=mock(makeFiles(79));
 const r=await analyzePullRequest({...target,postMode:'live'},m.dependencies);
 assert.equal(r.status,'partial');assert.equal(r.posted,0);
 assert.ok(r.coverage.reviewed<=35);
 assert.equal(r.coverage.reviewable,79);
 assert.equal(r.coverage.complete,false);
 assert.match(r.summary,/INCOMPLETE REVIEW/);
 assert.deepEqual(m.calls(),{posts:0,models:1});
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
