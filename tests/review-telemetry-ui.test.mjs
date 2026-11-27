import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewDetail} from '../src/ui.mjs';

test('authorized review detail shows provider usage and avoids guessed cost',async()=>{
  const row={id:1,pr_number:3,author:'example',pr_title:'Synthetic PR',
    full_name:'example/repo',head_sha:'a'.repeat(40),status:'completed',
    summary:'Offline review',findings_json:'[]',total_batches:1,completed_batches:1,
    results_json:JSON.stringify([{telemetry:{model:'test',durationMs:250,
      tokens:{inputTokens:20,outputTokens:5,totalTokens:25}}}])};
  const db={prepare:sql=>({get:async()=>{
    assert.match(sql,/prog\.results_json/);return row;
  }})};
  const html=await reviewDetail(db,{id:1,login:'example'},'csrf',1,
    {repositoryAccess:async()=>new Map([[1,2]])});
  assert.match(html,/recorded time: 250 ms/);
  assert.match(html,/reported tokens: 25 \(1\/1 calls\)/);
  assert.match(html,/Cost requires provider billing data/);
});

test('failed review detail exposes the durable error while withholding a clean verdict',async()=>{
  const row={id:2,pr_number:4,author:'example',pr_title:'Failed PR',
    full_name:'example/repo',head_sha:'b'.repeat(40),status:'failed',
    summary:'AI review incomplete; automatic replay disabled to prevent duplicate model costs.',
    error:'AI response did not complete [inputTokens=6000; totalTokens=6123]',
    findings_json:'[]',total_batches:1,completed_batches:0,results_json:'[]'};
  const db={prepare:()=>({get:async()=>row})};
  const html=await reviewDetail(db,{id:1,login:'example'},'csrf',2,
    {repositoryAccess:async()=>new Map([[1,2]])});
  assert.match(html,/Error: AI response did not complete/);
  assert.match(html,/totalTokens=6123/);
  assert.doesNotMatch(html,/✓ Clean/);
});
