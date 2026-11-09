import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePullRequest } from '../src/pipeline.mjs';

// Offline, synthetic legacy-pipeline regression. The per-batch validator
// already preserves these two independent causes on the same added line;
// legacy cross-batch aggregation must not silently collapse them again.
test('legacy review pipeline retains independent findings on one changed-line anchor', async () => {
  const headSha='a'.repeat(40);
  const path='src/order.ts';
  const findings=[
    {path,line:1,severity:'high',category:'security',title:'Missing caller authorization',
      body:'The new handler accepts calls without verifying caller access.',confidence:0.96},
    {path,line:1,severity:'medium',category:'correctness',title:'Missing replay protection',
      body:'The same newly added call can submit the transaction twice.',confidence:0.92}
  ];
  let modelCalls=0;
  const result=await analyzePullRequest({
    repository:'sandbox/sample',number:12,headSha,installationId:123,postMode:'dry-run'
  },{
    installationToken:async()=> 'synthetic-token',
    githubApi:async()=>({head:{sha:headSha},state:'open',draft:false}),
    changedFiles:async()=>[{filename:path,status:'added',
      patch:'@@ -0,0 +1,1 @@\n+await submit(input);'}],
    reviewWithAI:async()=>{
      modelCalls++;
      return {summary:'Two distinct issues at one anchor.',findings};
    },
    postReview:async()=>{throw new Error('Offline test must never post');}
  });
  assert.equal(result.status,'completed');
  assert.equal(result.posted,0);
  assert.equal(modelCalls,1);
  assert.deepEqual(result.findings.map(f=>f.title),[
    'Missing caller authorization','Missing replay protection'
  ]);
});
