import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase,seedDemo,createSession,getUserBySession,allowedReviews } from '../src/db.mjs';

test('SQLite schema, seeded demo, sessions, and free entitlement',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'reviewforge-test-'));
  try {
    const db=openDatabase(join(dir,'test.db'));await seedDemo(db);await seedDemo(db);
    const fixture=db.prepare('SELECT COUNT(*) n FROM reviews WHERE demo_user_id=-1').get();assert.equal(fixture.n,3);
    const token=await createSession(db,-1);const user=await getUserBySession(db,token);
    assert.equal(user.login,'demo');assert.equal(await getUserBySession(db,'invalid'),null);
    assert.deepEqual(await allowedReviews(db,-1),{plan:'free',limit:10,used:0});db.close();
  } finally{rmSync(dir,{recursive:true,force:true});}
});
