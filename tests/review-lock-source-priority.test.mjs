import test from 'node:test';
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {collectReviewContext} from '../src/review-context.mjs';
import {selectedReviewSkills,reviewSkillInstructions} from '../src/review-skills.mjs';

// Synthetic code and change ordering modeled on the independently reviewed
// Proffera #974 SHA 64e0f150: two earlier email files and a changed transaction
// advisory-lock wrapper in the SAME batch. No actual Proffera code is used.
const paths=[
  'src/features/email/booking-change-email.ts',
  'src/features/email/maria-deposit-email.ts',
  'src/lib/maria-booking-notification-lock.ts'
];
const sha='a'.repeat(40);
const files=paths.map((filename,index)=>({
  filename,status:'modified',
  patch:index===2
    ? '@@ -7,2 +7,3 @@ export async function withNoticeLock() {\n+  await client.query("SET LOCAL idle_in_transaction_session_timeout = 0");\n   return await action();'
    : '@@ -1,0 +1,1 @@\n+export const newBehavior = true;'
}));
const contents={
  [paths[0]]:'export const newBehavior = true;\n',
  [paths[1]]:'export const newBehavior = true;\n',
  [paths[2]]:[
    'export async function withNoticeLock(action) {',
    '  await client.query("BEGIN");',
    '  await client.query("SET LOCAL lock_timeout = 5000");',
    '  await client.query("SET LOCAL idle_in_transaction_session_timeout = 0");',
    '  await client.query("SELECT pg_advisory_xact_lock(713)");',
    '  return await action();',
    '}'
  ].join('\n')
};
const api=async(url,token)=>{
  assert.equal(token,'SYNTHETIC_ONLY');
  const prefix='/repos/example/review-context/contents/';
  assert.ok(url.startsWith(prefix));
  const [suffix,ref]=url.slice(prefix.length).split('?ref=');
  assert.equal(ref,sha);
  const key=decodeURIComponent(suffix);
  if(!(key in contents))throw new Error('GitHub 404: Not Found');
  const body=contents[key];
  return {type:'file',size:Buffer.byteLength(body),encoding:'base64',
    content:Buffer.from(body).toString('base64')};
};
test('changed advisory-lock holder receives full bounded SHA-pinned source context',async()=>{
  const c=await collectReviewContext({
    repository:'example/review-context',sha,files,api,token:'SYNTHETIC_ONLY'
  });
  const excerpts=c.snippets.filter(x=>x.kind==='changed-file-excerpt');
  assert.equal(excerpts.length,2,'Do not enlarge existing changed-source cap');
  assert.ok(excerpts.some(x=>x.path===paths[2]),
    'Changed lock-holder source must not be displaced by unrelated earlier email edits');
  assert.ok(excerpts.find(x=>x.path===paths[2]).text.includes('pg_advisory_xact_lock'));
  assert.ok(c.totalChars<=12000,'Keep bounded context and no additional model calls');
});
test('ordinary non-lock changed sources retain original stable priority',async()=>{
  const c=await collectReviewContext({
    repository:'example/review-context',sha,files:files.slice(0,2),api,token:'SYNTHETIC_ONLY'
  });
  assert.deepEqual(c.snippets.filter(x=>x.kind==='changed-file-excerpt').map(x=>x.path),paths.slice(0,2));
});
test('advisory/transaction lock lifetime is explicitly audited, not just acquisition timeout',()=>{
  const skills=selectedReviewSkills(files).map(x=>x.id);
  assert.ok(skills.includes('db-lock-lifetime'));
  const instructions=reviewSkillInstructions(files);
  assert.match(instructions,/lock_timeout.*acquisition.*lock.*lifetime/i);
  assert.match(instructions,/callback.*cancel/i);
});
test('truncated diff or source excerpts cannot justify an end-of-file syntax claim',()=>{
  const instructions=reviewSkillInstructions(files);
  assert.match(instructions,/Do not infer end-of-file/i);
  assert.match(instructions,/complete source.*actual file end/i);
});
