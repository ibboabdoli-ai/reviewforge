import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Installation synchronization awaits PostgreSQL write branches', () => {
  const source=readFileSync(new URL('../src/github.mjs',import.meta.url),'utf8');
  assert.match(source,/else await db\.prepare\('UPDATE repositories SET enabled=0 WHERE installation_id=\?'\)\.run\(inst\.id\)/);
  assert.match(source,/if\(ids\.length\)await db\.prepare\(`UPDATE installations SET status='disconnected'/);
  assert.match(source,/else await db\.prepare\(`UPDATE installations SET status='disconnected'/);
});
