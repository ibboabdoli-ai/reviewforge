import test from 'node:test';
import assert from 'node:assert/strict';
import {planReviewBatches,selectFilesForReview,addedLines} from '../src/reviewer.mjs';

// Synthetic counterpart of a portal guard relocated to run before a
// recovery-attempt reservation. Same guarded function and byte-identical lines.
const moved=[
  '@@ -10,5 +10,7 @@ export function verifyCode(token) {',
  '   if (isRevoked(token)) return false;',
  '+  const permitted = portalAccessAllowed(token);',
  '+  if (!permitted) return false;',
  '   const attempt = reserveAttempt(token);',
  '@@ -30,6 +32,4 @@ export function verifyCode(token) {',
  '   if (!matchesCode(token)) return false;',
  '-  const permitted = portalAccessAllowed(token);',
  '-  if (!permitted) return false;',
  '   return true;'
].join('\n');
const file=patch=>[{filename:'src/lib/verification.ts',status:'modified',patch}];
const coverage=patch=>planReviewBatches(file(patch)).coverage;

test('byte-identical guard moved earlier in the same function remains fully reviewable',()=>{
  const planned=planReviewBatches(file(moved));
  assert.equal(planned.coverage.complete,true);
  assert.equal(planned.coverage.reviewed,1);
  assert.equal(planned.coverage.unanchoredDeletions,0);
  assert.equal(planned.batches.length,1);
  assert.ok(addedLines(moved).size>=2,'Relocated code must have actual new-line anchors');
  assert.equal(selectFilesForReview(file(moved)).coverage.complete,true);
});

test('pure deletion with no added anchor is still refused',()=>{
  const deletion=moved.replace(
    '+  const permitted = portalAccessAllowed(token);\n+  if (!permitted) return false;\n','');
  assert.equal(coverage(deletion).complete,false);
  assert.equal(coverage(deletion).unanchoredDeletions,1);
});

test('same removed lines moved into a different function remain partial',()=>{
  const different=moved.replace('@@ -10,5 +10,7 @@ export function verifyCode(token) {',
    '@@ -10,5 +10,7 @@ export function adminCode(token) {');
  assert.equal(coverage(different).complete,false);
  assert.equal(coverage(different).unanchoredDeletions,1);
});

test('not-quite-identical replacement cannot falsely satisfy deletion-only guard',()=>{
  const changed=moved.replace('+  if (!permitted) return false;',
    '+  if (!permitted && !isStaff(token)) return false;');
  assert.equal(coverage(changed).complete,false);
  assert.equal(coverage(changed).unanchoredDeletions,1);
});

test('a deletion-only hunk containing multiple separated removal runs remains partial',()=>{
  const split=moved.replace(
    '-  const permitted = portalAccessAllowed(token);\n-  if (!permitted) return false;',
    '-  const permitted = portalAccessAllowed(token);\n   audit(token);\n-  if (!permitted) return false;'
  );
  assert.equal(coverage(split).complete,false);
  assert.equal(coverage(split).unanchoredDeletions,1);
});

test('unnamed hunk scopes do not waive the incomplete-review gate',()=>{
  const unnamed=moved.replaceAll(' @@ export function verifyCode(token) {',' @@');
  assert.equal(coverage(unnamed).complete,false);
  assert.equal(coverage(unnamed).unanchoredDeletions,1);
});

/**
 * Codex P1 reproduction: two different object methods share a Git hunk
 * header. Moving the private-route guard to the public route must NOT make
 * a deletion-only private-route hunk look fully reviewed.
 * The private method now returns SECRET to an unauthorized caller.
 */
test('a shared object-header is not proof of the same guarded function',()=>{
  const crossMethod=[
    '@@ -10,4 +10,5 @@ export const handlers = {',
    '   publicRoute(request) {',
    '+    if (!request.isAdmin) return "DENIED";',
    '+    return "PUBLIC";',
    '   },',
    '@@ -30,5 +31,4 @@ export const handlers = {',
    '   privateRoute(request) {',
    '-    if (!request.isAdmin) return "DENIED";',
    '     return "SECRET";',
    '   }',
  ].join('\n');
  const planned=planReviewBatches(file(crossMethod));
  assert.equal(planned.coverage.complete,false,
    'Private-route deletion has no added-line anchor: fail closed');
  assert.equal(planned.coverage.unanchoredDeletions,1);
  assert.equal(selectFilesForReview(file(crossMethod)).coverage.complete,false);
});
