import test from 'node:test';
import assert from 'node:assert/strict';
import { postReview } from '../src/github.mjs';

// No network or AI calls: GitHub API requests are intercepted in-process.
const oldSha='a'.repeat(40), newSha='b'.repeat(40);
const target={repoFullName:'synthetic/review-fallback',prNumber:17,
  headSha:oldSha,token:'fixture-only',summary:'Synthetic review.',findings:[],approval:false};
function json(status,data){
  return {ok:status>=200&&status<300,status,
    text:async()=>JSON.stringify(data)};
}
function simulate(t,currentSha){
  const calls=[];
  t.mock.method(globalThis,'fetch',async (url,options)=>{
    const endpoint=new URL(url).pathname;
    const method=options?.method||'GET';
    calls.push({endpoint,method,body:options?.body ? JSON.parse(options.body) : null});
    if(endpoint==='/repos/synthetic/review-fallback/pulls/17/reviews'&&method==='POST')
      return json(422,{message:'Validation Failed: inline review could not be attached'});
    if(endpoint==='/repos/synthetic/review-fallback/pulls/17'&&method==='GET')
      return json(200,{head:{sha:currentSha},state:'open',draft:false});
    if(endpoint==='/repos/synthetic/review-fallback/issues/17/comments'&&method==='POST')
      return json(201,{id:1});
    throw Error('Unexpected fixture request: '+method+' '+endpoint);
  });
  return calls;
}
test('a rejected inline review must not fall back to a stale-HEAD issue comment',async t=>{
  const calls=simulate(t,newSha);
  await assert.rejects(postReview(target),/head|changed|stale|superseded|fallback/i);
  assert.equal(calls.filter(c=>c.endpoint.endsWith('/issues/17/comments')).length,0,
    'A 422 caused by a superseded commit must not publish a stale summary');
  assert.equal(calls.filter(c=>c.endpoint.endsWith('/pulls/17')&&c.method==='GET').length,1);
});
test('same-HEAD inline 422 still permits exactly one summary fallback',async t=>{
  const calls=simulate(t,oldSha);
  assert.equal(await postReview(target),'summary');
  assert.equal(calls.filter(c=>c.endpoint.endsWith('/issues/17/comments')).length,1);
  assert.equal(calls.filter(c=>c.endpoint.endsWith('/pulls/17')&&c.method==='GET').length,1);
});

// Regression fixture: a full synthetic review must remain actionable even when
// GitHub rejects inline annotations and the HEAD remains current. No network.
test('same-HEAD 422 fallback retains the validated finding instead of silently dropping it',async t=>{
  const calls=simulate(t,oldSha);
  const syntheticFinding={path:'src/receipt-gate.ts',line:9,severity:'high',
    title:'Reject stale review receipt',
    body:'A mismatched reviewed commit must not pass the final approval gate.',
    confidence:0.95};
  const result=await postReview({...target,findings:[syntheticFinding]});
  assert.equal(result,'summary');
  const fallback=calls.filter(c=>c.endpoint.endsWith('/issues/17/comments')&&c.method==='POST');
  assert.equal(fallback.length,1);
  const posted=fallback[0].body.body;
  assert.match(posted,/src\\/receipt-gate\\.ts/);
  assert.match(posted,/line\\s*9|:9\\b/i);
  assert.match(posted,/Reject stale review receipt/);
  assert.match(posted,/mismatched reviewed commit/);
});
