import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.mjs';
import { analyzePullRequestStep } from '../src/incremental-review.mjs';

const headSha='a'.repeat(40);
const target={reviewId:71,repository:'ibboabdoli-ai/Proffera',number:12,
  headSha,installationId:3,postMode:'dry-run',allowDraft:true};
const files=Array.from({length:36},(_,i)=>({filename:`src/file${i}.ts`,status:'modified',
  patch:`@@ -0,0 +1 @@\n+export const n${i} = ${i};`}));

function deps(extra={}){
  return {
    githubApi:async()=>({state:'open',draft:true,head:{sha:headSha}}),
    installationToken:async()=> 'test-token',
    changedFiles:async()=>files,
    loadProgress:async()=>null,
    initProgress:async()=>true,
    saveProgress:async()=>true,
    ...extra
  };
}

test('a Draft Proffera review stops before model use when pilot ceiling is exhausted',async()=>{
  const original={enabled:config.aiProfferaPilotEnabled,limit:config.aiPilotMaxModelCalls};
  config.aiProfferaPilotEnabled=true;config.aiPilotMaxModelCalls=10;
  let calls=0;
  try{
    const result=await analyzePullRequestStep(target,deps({
      reserveModelCalls:async()=>({allowed:false,reason:'pilot-exhausted'}),
      reviewWithAI:async()=>{calls++;return {summary:'unexpected',findings:[]};}
    }));
    assert.equal(result.status,'partial');
    assert.equal(calls,0);
  }finally{config.aiProfferaPilotEnabled=original.enabled;config.aiPilotMaxModelCalls=original.limit;}
});

test('turning pilot limit to zero stops a saved multi-batch review',async()=>{
  const original={enabled:config.aiProfferaPilotEnabled,limit:config.aiPilotMaxModelCalls};
  config.aiProfferaPilotEnabled=true;config.aiPilotMaxModelCalls=10;
  let progress=null,modelCalls=0;
  const d=deps({
    reserveModelCalls:async()=>({allowed:true}),
    loadProgress:async()=>progress,
    initProgress:async p=>{progress={plan_hash:p.planHash,total_batches:p.totalBatches,
      completed_batches:0,results_json:'[]'};return true;},
    saveProgress:async p=>{progress.completed_batches=p.completedBatches;
      progress.results_json=JSON.stringify(p.results);return true;},
    reviewWithAI:async()=>{modelCalls++;return {summary:'reviewed',findings:[]};}
  });
  try{
    const first=await analyzePullRequestStep(target,d);
    assert.equal(first.status,'progress');
    assert.equal(modelCalls,1);
    config.aiPilotMaxModelCalls=0;
    const second=await analyzePullRequestStep(target,d);
    assert.ok(['superseded','partial'].includes(second.status));
    assert.equal(modelCalls,1);
  }finally{config.aiProfferaPilotEnabled=original.enabled;config.aiPilotMaxModelCalls=original.limit;}
});
