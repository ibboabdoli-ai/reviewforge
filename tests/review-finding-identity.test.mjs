import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFindings, unverifiedModelSuggestions } from '../src/reviewer.mjs';
import { findingIdentity, distinctFindings } from '../src/finding-identity.mjs';

// Synthetic regression: a single added statement can independently enable
// unauthorized access and replay. Both findings have a valid shared anchor.
const filename='src/handlers/submit.ts';
const file={filename,patch:'@@ -0,0 +1,1 @@\n+await sendRequest(input);'};
const make=(title,category,severity='high')=>({
  path:filename,line:1,severity,category,title,
  body:'Independently actionable synthetic regression at the new line.',
  confidence:0.94
});

test('independent same-line root causes survive model anchor validation',()=>{
  const auth=make('Missing caller authorization','security');
  const replay=make('Missing idempotency token','correctness');
  assert.notEqual(findingIdentity(auth),findingIdentity(replay));
  const accepted=validateFindings([auth,replay],[file]);
  assert.deepEqual(accepted.map(f=>f.title),
    ['Missing caller authorization','Missing idempotency token']);
  assert.equal(unverifiedModelSuggestions({findings:[auth,replay]},accepted),false);
});

test('same-root duplicates still collapse; most severe wins before cap',()=>{
  const low=make(' Missing   caller authorization ',' Security ','low');
  const critical=make('missing caller authorization','security','critical');
  const accepted=validateFindings([low,critical],[file]);
  assert.equal(accepted.length,1);
  assert.equal(accepted[0].severity,'critical');
});

test('cross-batch aggregation keeps independent same-line issues and removes repeated causes',()=>{
  const auth=make('Missing caller authorization','security');
  const replay=make('Missing idempotency token','correctness');
  const another={...auth,title:'  MISSING  caller authorization  ',severity:'low'};
  // The caller ranks highest severity first before de-duplicating.
  const selected=distinctFindings([auth,replay,another],8);
  assert.deepEqual(selected.map(f=>f.title),
    ['Missing caller authorization','Missing idempotency token']);
  assert.equal(distinctFindings([auth,replay,another],1).length,1);
});
