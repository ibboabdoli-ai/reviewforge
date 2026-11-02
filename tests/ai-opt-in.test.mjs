import test from 'node:test';
import assert from 'node:assert/strict';
import { config, integrations } from '../src/config.mjs';
import { analyzePullRequest } from '../src/pipeline.mjs';

test('Adding API key does NOT enable AI review until opted in', () => {
  const prevFlag = config.aiReviewEnabled, prevKey = config.openai.apiKey;
  try {
    config.aiReviewEnabled = false; config.openai.apiKey='sk-test-not-real';
    assert.equal(integrations().ai,false);
    config.aiReviewEnabled = true;
    assert.equal(integrations().ai,true);
    config.openai.apiKey='';
    assert.equal(integrations().ai,false);
  } finally {
    config.aiReviewEnabled=prevFlag; config.openai.apiKey=prevKey;
  }
});
test('Dry-run review never posts, even with a valid model result', async () => {
  const sha='a'.repeat(40);
  let posted=0, modeled=0;
  const deps={
    installationToken:async()=> 'fake-token',
    githubApi:async()=>({head:{sha},draft:false,state:'open'}),
    changedFiles:async()=>[{filename:'src/safe.js',patch:'@@ -1,0 +1,1 @@\n+const x=1;',status:'modified'}],
    reviewWithAI:async()=>{modeled++;return {summary:'No issues',findings:[]};},
    postReview:async()=>{posted++;return 'inline';}
  };
  const result=await analyzePullRequest({repository:'test/repo',number:1,headSha:sha,installationId:1,postMode:'dry-run'},deps);
  assert.equal(result.posted,0); assert.equal(posted,0); assert.equal(modeled,1);
  assert.match(result.summary,/Preview only/);
});
