import test from 'node:test';
import assert from 'node:assert/strict';
import {selectFilesForReview,planReviewBatches} from '../src/reviewer.mjs';
import {analyzePullRequest} from '../src/pipeline.mjs';

// Synthetic deleted paths with no added-line anchors. Removing a CODEOWNERS
// file, a container build definition or an SQL migration must never be called
// a fully reviewed change merely because another code patch is valid.
const missingGates=[
  {filename:'.github/CODEOWNERS',status:'removed',patch:'@@ -1 +0,0 @@\n-* @trusted-reviewers'},
  {filename:'Dockerfile',status:'removed',patch:'@@ -1 +0,0 @@\n-RUN npm ci'},
  {filename:'db/migrations/restrict-tenant-access.sql',status:'removed',
    patch:'@@ -1 +0,0 @@\n-REVOKE ALL ON bookings FROM public;'}
];
const changed={filename:'src/lib/health.ts',status:'modified',
  patch:'@@ -1 +1 @@\n-export const healthy=false;\n+export const healthy=true;'};
const sha='f'.repeat(40);

test('deleted ownership, container and SQL gates count as unreviewed in both planners',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const {coverage}=planner([...missingGates,changed]);
    assert.equal(coverage.removedCode,3,'all three omitted gate deletions must count');
    assert.equal(coverage.reviewable,4);
    assert.equal(coverage.reviewed,1);
    assert.equal(coverage.complete,false,'removing critical files cannot produce a clean verdict');
  }
});

test('deleted critical extensionless and SQL files fail closed before quota, model or post',async()=>{
  let models=0,posts=0,reservations=0;
  const result=await analyzePullRequest(
    {repository:'test/reviewforge',number:41,headSha:sha,postMode:'live',installationId:42},
    {
      githubApi:async()=>({head:{sha},state:'open',draft:false}),
      installationToken:async()=> 'synthetic-token',
      changedFiles:async()=> [...missingGates,changed],
      reserveModelCalls:async()=>{reservations++;return {allowed:true};},
      reviewWithAI:async()=>{models++;return {summary:'No issues',findings:[]};},
      postReview:async()=>{posts++;return 'inline';}
    }
  );
  assert.equal(result.status,'partial');
  assert.equal(result.coverage.removedCode,3);
  assert.match(result.summary,/INCOMPLETE REVIEW/);
  assert.deepEqual({reservations,models,posts},{reservations:0,models:0,posts:0});
});

test('ordinary removed documentation remains excluded',()=>{
  for(const planner of [selectFilesForReview,planReviewBatches]){
    const {coverage}=planner([
      {filename:'docs/changelog.md',status:'removed',patch:'@@ -1 +0,0 @@\n-old changelog'},
      changed
    ]);
    assert.equal(coverage.complete,true);
    assert.equal(coverage.reviewable,1);
    assert.equal(coverage.excluded,1);
  }
});
