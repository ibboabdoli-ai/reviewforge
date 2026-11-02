import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePullRequest } from '../src/pipeline.mjs';

const sha='a'.repeat(40), second='b'.repeat(40);
const target={repository:'sandbox/sample',number:4,headSha:sha,installationId:123};
const files=[{filename:'src/checkout.ts',status:'modified',patch:'@@ -10,1 +10,2 @@\n old\n+const password = request.password;'}];
const report={summary:'Review found a logging exposure.',findings:[{path:'src/checkout.ts',line:11,title:'Exposure',severity:'high',category:'security',body:'Avoid exposing sensitive values.',confidence:0.95}]};
function deps(heads=[sha,sha],extra={}){
  let lookups=0,posts=0,analyses=0;
  const methods={
    installationToken:async()=> 'installation_token_fixture',
    githubApi:async(path,token)=>{assert.equal(path,'/repos/sandbox/sample/pulls/4');assert.equal(token,'installation_token_fixture');return {head:{sha:heads[Math.min(lookups++,heads.length-1)]},state:'open',draft:false};},
    changedFiles:async()=>files,
    reviewWithAI:async f=>{analyses++;assert.equal(f[0].filename,'src/checkout.ts');return report;},
    postReview:async params=>{posts++;assert.equal(params.headSha,sha);return 'inline';},
    ...extra
  };
  return {methods,counts:()=>({lookups,posts,analyses})};
}
test('Dry-run performs model analysis but never publishes to GitHub',async()=>{
  const d=deps();const result=await analyzePullRequest({...target,postMode:'dry-run'},d.methods);
  assert.equal(result.status,'completed');assert.equal(result.posted,0);
  assert.match(result.summary,/Preview only/);
  assert.equal(result.findings.length,1);
  assert.deepEqual(d.counts(),{lookups:2,posts:0,analyses:1});
});
test('Live mode publishes only after the second HEAD validation',async()=>{
  const d=deps();const result=await analyzePullRequest({...target,postMode:'live'},d.methods);
  assert.equal(result.status,'completed');assert.equal(result.posted,1);
  assert.deepEqual(d.counts(),{lookups:2,posts:1,analyses:1});
});
test('Changed HEAD cannot receive stale review comments',async()=>{
  const d=deps([sha,second]);const result=await analyzePullRequest({...target,postMode:'live'},d.methods);
  assert.equal(result.status,'superseded');assert.equal(result.posted,0);
  assert.deepEqual(d.counts(),{lookups:2,posts:0,analyses:1});
});
test('Invalid targets are rejected before any GitHub access',async()=>{
  await assert.rejects(analyzePullRequest({...target,headSha:'not-a-sha',postMode:'live'},deps().methods),/Invalid review target/);
});
test('Draft PRs are skipped without sending diffs to AI',async()=>{
  const d=deps(undefined,{githubApi:async()=>({head:{sha},state:'open',draft:true})});
  const result=await analyzePullRequest({...target,postMode:'live'},d.methods);
  assert.equal(result.status,'skipped');assert.equal(d.counts().analyses,0);assert.equal(d.counts().posts,0);
});
