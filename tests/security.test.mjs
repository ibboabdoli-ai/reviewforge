import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyGithub,verifyStripe,safeCompare,encrypt,decrypt,csrfFor,htmlEscape } from '../src/security.mjs';

test('GitHub HMAC SHA256 matches official reference and rejects tampering',()=>{
  const secret="It's a Secret to Everybody",body='Hello, World!';
  const sig='sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17';
  assert.equal(verifyGithub(body,sig,secret),true);
  assert.equal(verifyGithub(body+'!',sig,secret),false);
  assert.equal(verifyGithub(body,'sha256=invalid',secret),false);
  assert.equal(verifyGithub(body,sig,''),false);
});
test('Stripe signature verifies with timestamp tolerance and rejects replay outside window',()=>{
  const payload='{"id":"evt_test"}',secret='whsec_testing',now=1700000000;
  const sig=createHmac('sha256',secret).update(`${now}.${payload}`).digest('hex');
  assert.equal(verifyStripe(payload,`t=${now},v1=${sig}`,secret,now*1000),true);
  assert.equal(verifyStripe(payload+'x',`t=${now},v1=${sig}`,secret,now*1000),false);
  assert.equal(verifyStripe(payload,`t=${now},v1=${sig}`,secret,(now+301)*1000),false);
});
test('Sensitive token encryption round-trip and tamper detection',()=>{
  const key='a'.repeat(64),token='ghu_very_secret';
  const ciphertext=encrypt(token,key);assert.notEqual(ciphertext,token);
  assert.equal(decrypt(ciphertext,key),token);
  assert.throws(()=>decrypt(ciphertext.slice(0,-3)+'xxx',key));
});
test('CSRF tokens depend on session and no HTML injection',()=>{
  assert.equal(safeCompare(csrfFor('sessionA','a'.repeat(32)),csrfFor('sessionB','a'.repeat(32))),false);
  assert.equal(htmlEscape('<script>'), '&lt;script&gt;');
});
