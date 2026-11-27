import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePullRequestStep} from '../src/incremental-review.mjs';
import {planReviewBatches} from '../src/reviewer.mjs';
import {config} from '../src/config.mjs';

test('staged review supplies only the current batch its own immutable source context',async()=>{
 const repo='sample/context-fixture',headSha='d'.repeat(40);
 const previous=config.aiContextRepositories;config.aiContextRepositories=[repo];
 const files=['one','two','three'].map((name,i)=>({filename:`src/lib/${name}.ts`,status:'modified',
  patch:'@@ -0,0 +1,110 @@\n'+Array.from({length:110},(_,n)=>`+const line${n}=${JSON.stringify(name+'x'.repeat(62))};`).join('\n')}));
 const plan=planReviewBatches(files,{maxBatchCharacters:24000});
 assert.ok(plan.coverage.complete);assert.ok(plan.batches.length>=2);
 const rows=new Map(),seen=[];let posts=0,contextCalls=0,contentReads=0,steps=0;
 const deps={
  installationToken:async()=> 'fixture',
  githubApi:async(path)=>{
   if(path.includes('/contents/')){
    contentReads++;assert.ok(path.endsWith('?ref='+headSha));
    return {type:'file',encoding:'base64',size:2,content:'eA=='};
   }
   return {head:{sha:headSha},state:'open',draft:false};
  },
  changedFiles:async()=>{steps++;return files;},
  collectReviewContext:async({sha,files:part,api})=>{
   assert.equal(sha,headSha);contextCalls++;
   await api('/repos/'+repo+'/contents/src/lib/shared.ts?ref='+sha,'fixture');
   const sourceFiles=[...new Set(part.map(f=>f.filename))];
   return {headSha:sha,sourceFiles,snippets:[],projectRules:'',testLinks:[],totalChars:0};
  },
  loadProgress:async id=>rows.get(id)||null,
  initProgress:async({reviewId,planHash,totalBatches})=>{
   rows.set(reviewId,{plan_hash:planHash,total_batches:totalBatches,completed_batches:0,results_json:'[]'});return true;
  },
  saveProgress:async({reviewId,previousBatches,completedBatches,results})=>{
   const row=rows.get(reviewId);assert.equal(row.completed_batches,previousBatches);
   row.completed_batches=completedBatches;row.results_json=JSON.stringify(results);return true;
  },
  reserveModelCalls:async()=>true,
  reviewWithAI:async(batch,{reviewContext})=>{
   seen.push({batch:[...new Set(batch.map(f=>f.filename))],context:reviewContext.sourceFiles});
   return {summary:'mock only',findings:[]};
  },
  postReview:async()=>{posts++;throw new Error('No posting in dry-run');}
 };
 try{
  let result;
  do{result=await analyzePullRequestStep({reviewId:7,repository:repo,number:3,
    headSha,installationId:1,postMode:'dry-run',allowDraft:true},deps);}while(result.status==='progress');
  assert.equal(result.status,'completed');assert.equal(result.posted,0);assert.equal(posts,0);
  assert.equal(seen.length,plan.batches.length);
  for(const item of seen)assert.deepEqual(item.context,item.batch);
  assert.ok(contextCalls>=plan.batches.length);
  assert.equal(contentReads,steps); // One cached SHA-pinned read per staged invocation.
 }finally{config.aiContextRepositories=previous;}
});
