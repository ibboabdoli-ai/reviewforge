import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePullRequest} from '../src/pipeline.mjs';
const sha='a'.repeat(40);
const target={repository:'example/sandbox',number:1,headSha:sha,installationId:1,postMode:'fallback'};
function run({findings=[],fileCount=1,heads=[sha,sha]}={}){
  const calls=[];let checked=0;
  const files=Array.from({length:fileCount},(_,i)=>({filename:'src/feature-'+i+'.ts',status:'modified',patch:'@@ -0,0 +1,1 @@\n+const changed'+i+'=1;'}));
  const d={
    githubApi:async()=>({head:{sha:heads[Math.min(checked++,heads.length-1)]},state:'open',draft:false}),
    installationToken:async()=> 'fake',
    changedFiles:async()=>files,
    reviewWithAI:async()=>({summary:'Checked only shown diff.',findings}),
    postReview:async arg=>{calls.push(arg);return 'inline';}
  };
  return {result:analyzePullRequest(target,d),calls};
}
test('clean full exact-head fallback publishes an approval request',async()=>{
 const {result,calls}=run();
 const r=await result;
 assert.equal(r.status,'completed');assert.equal(r.coverage.complete,true);
 assert.equal(calls.length,1);assert.equal(calls[0].approval,true);
 assert.equal(calls[0].findings.length,0);
});
test('actionable findings may be reported but must never approve',async()=>{
 const {result,calls}=run({findings:[{path:'src/feature-0.ts',line:1,severity:'high',category:'security',
 title:'Ownership missing',body:'Check request owner before changing data.',confidence:.98}]});
 const r=await result;
 assert.equal(r.status,'completed');assert.equal(calls.length,1);assert.equal(calls[0].approval,false);
});
test('incomplete review never posts approval or comments',async()=>{
 const {result,calls}=run({fileCount:181});
 const r=await result;
 assert.equal(r.status,'partial');assert.equal(r.posted,0);assert.equal(calls.length,0);
});
test('head changed during analysis never posts even on a clean result',async()=>{
 const {result,calls}=run({heads:[sha,'b'.repeat(40)]});
 const r=await result;
 assert.equal(r.status,'superseded');assert.equal(calls.length,0);
});
