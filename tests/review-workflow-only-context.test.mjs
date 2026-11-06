import test from 'node:test';
import assert from 'node:assert/strict';
import { collectReviewContext, MAX_CONTEXT_CHARS } from '../src/review-context.mjs';

test('three changed workflow gates without a JS adapter all receive SHA-pinned source context',async()=>{
  // Synthetic follow-up to the PR962-shaped regression: the third workflow
  // must not disappear merely because the same PR has no scripts/ adapter.
  const sha='d'.repeat(40), repository='sample/workflow-fixture';
  const names=[
    '.github/workflows/ci.yml',
    '.github/workflows/review-gate.yml',
    '.github/workflows/final-gate.yml'
  ];
  const sources=Object.fromEntries(names.map((name,i)=>[
    name,'existing\n'+'guard'+(i+1)+': reject-ambiguous-evidence\n'
  ]));
  const files=names.map((filename,i)=>({
    filename,status:'modified',
    patch:'@@ -1,1 +1,2 @@\n existing\n+guard'+(i+1)+': reject-ambiguous-evidence'
  }));
  const requests=[];
  const api=async(url,token)=>{
    assert.equal(token,'fake-fixture-token');
    const match=url.match(/^\/repos\/sample\/workflow-fixture\/contents\/(.+)\?ref=([a-f0-9]{40})$/);
    assert.ok(match,'only immutable same-repository reads are allowed');
    assert.equal(match[2],sha);
    const path=decodeURIComponent(match[1]);requests.push(path);
    if(path==='.coderabbit.yaml')throw new Error('GitHub 404: Not Found');
    assert.ok(Object.hasOwn(sources,path),'unexpected file: '+path);
    const source=sources[path];
    return {type:'file',encoding:'base64',size:Buffer.byteLength(source),
      content:Buffer.from(source).toString('base64')};
  };
  const result=await collectReviewContext({
    repository,sha,files,token:'fake-fixture-token',api
  });
  assert.deepEqual(result.sourceFiles,names);
  assert.ok(result.snippets.some(s=>s.path===names[2]&&s.text.includes('guard3')));
  assert.ok(requests.includes(names[2]));
  assert.ok(result.totalChars<=MAX_CONTEXT_CHARS);
});
