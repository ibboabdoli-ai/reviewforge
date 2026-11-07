import test from 'node:test';
import assert from 'node:assert/strict';
import {openDatabase} from '../src/db.mjs';

test('SQLite in-memory mode is rejected before creating unusable transaction helpers',()=>{
  assert.throws(()=>openDatabase(':memory:'),/file-backed SQLite database/i);
});
