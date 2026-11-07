import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePullRequest } from '../src/pipeline.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';

// No real GitHub, provider API, database, payment or review publication.
const sha='a'.repeat(40);
const files=[{filename:'src/access-control.ts',status:'modified',
  patch:'@@ -0,0 +1,1 @@\n+export const checkAccess = () => true;'}];
const filtered={summary:'A concern was suggested but failed evidence validation.',
  findings:[],diagnostics:{modelSuggestions:1,acceptedFindings:0,filteredFindings:1}};
const droppedAfterModel={summary:'An invalid diff anchor must not become a clean verdict.',
  findings:[{path:'src/another-file.ts',line:99,severity:'high',
    category:'security',title:'Unsupported anchor',
    body:'The referenced file was not part of this patch.',confidence:.97}]};
const validFinding={path:'src/access-control.ts',line:1,severity:'high',
  category:'security',title:'Missing access check',
  body:'The changed function unconditionally allows unauthorized access.',confidence:.98};
const mixed={summary:'One actionable bug and one unsupported suggestion.',
  findings:[validFinding],diagnostics:{modelSuggestions:2,acceptedFindings:1,filteredFindings:1}};
const capped={summary:'Eight actionable issues from a nine-suggestion batch.',
  findings:Array.from({length:8},(_,i)=>({...validFinding,
    path:'src/entry-'+i+'.ts',title:'Issue '+i})),
  diagnostics:{modelSuggestions:9,acceptedFindings:8,filteredFindings:1}};
const cappedFiles=Array.from({length:9},(_,i)=>({
  filename:'src/entry-'+i+'.ts',status:'modified',
  patch:'@@ -0,0 +1,1 @@\\n+const changed'+i+' = true;'
}));
const clean={summary:'No supported concerns identified.',
  findings:[],diagnostics:{modelSuggestions:0,acceptedFindings:0,filteredFindings:0}};

function dependencies(response,changedFiles=files){
  const posts=[];
  return {posts,deps:{
    githubApi:async()=>({head:{sha},state:'open',draft:false}),
    installationToken:async()=> 'synthetic-installation-token',
    changedFiles:async()=>changedFiles,
    reviewWithAI:async()=>response,
    postReview:async args=>{posts.push(args);return 'inline';},
    loadProgress:async()=>null,
    initProgress:async()=>true,
    saveProgress:async()=>true
  }};
}
const classic={repository:'synthetic/fixture',number:23,headSha:sha,
  installationId:10,postMode:'fallback'};
const staged={...classic,reviewId:23};

for(const [label,runner,target] of [
  ['classic',analyzePullRequest,classic],
  ['staged',analyzePullRequestStep,staged]
]){
  test(label+': filtered model suggestions must not become a clean fallback approval',async()=>{
    const {posts,deps}=dependencies(filtered);
    const result=await runner(target,deps);
    assert.equal(result.status,'partial');
    assert.equal(result.posted,0);
    assert.equal(posts.length,0);
    assert.match(result.summary,/filtered|unreportable|unverified|manual/i);
  });
  test(label+': suggestions discarded by downstream anchor checks must not approve',async()=>{
    const {posts,deps}=dependencies(droppedAfterModel);
    const result=await runner(target,deps);
    assert.equal(result.status,'partial');
    assert.equal(result.posted,0);
    assert.equal(posts.length,0);
  });
  test(label+': valid findings must remain reportable when unrelated model suggestions were rejected',async()=>{
    const {posts,deps}=dependencies(mixed);
    const result=await runner(target,deps);
    assert.equal(result.status,'completed');
    assert.equal(result.findings.length,1);
    assert.equal(posts.length,1);
    assert.equal(posts[0].approval,false);
    assert.equal(posts[0].findings[0].title,validFinding.title);
  });
  test(label+': the eight-finding reporting cap must not suppress eight real findings',async()=>{
    const {posts,deps}=dependencies(capped,cappedFiles);
    const result=await runner(target,deps);
    assert.equal(result.status,'completed');
    assert.equal(result.findings.length,8);
    assert.equal(posts.length,1);
    assert.equal(posts[0].approval,false);
  });
  test(label+': a fully validated model response with zero suggestions may approve',async()=>{
    const {posts,deps}=dependencies(clean);
    const result=await runner(target,deps);
    assert.equal(result.status,'completed');
    assert.equal(posts.length,1);
    assert.equal(posts[0].approval,true);
  });
}
