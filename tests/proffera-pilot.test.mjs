import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isProffera,pilotCallLimit,PROFFERA_PILOT_KEY,reserveProfferaPilotCalls,effectiveReviewPostMode,pullRequestAllowedPastFallbackGate } from '../src/review-policy.mjs';

function memoryDb(){
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE ai_daily_limits(day TEXT PRIMARY KEY, used INTEGER NOT NULL CHECK(used>=0))');
  return {sql,prepare:statement=>({get:(...args)=>sql.prepare(statement).get(...args)})};
}

test('pilot is exact-repository and defaults closed',()=>{
  assert.equal(isProffera('ibboabdoli-ai/Proffera'),true);
  assert.equal(isProffera('someone/Proffera'),false);
  assert.equal(pilotCallLimit(''),0);
  assert.equal(pilotCallLimit('11'),0);
  assert.equal(pilotCallLimit('10'),10);
});

test('Proffera pilot cannot publish even when fallback approval is configured',()=>{
  const repository='ibboabdoli-ai/Proffera',list=[repository.toLowerCase()];
  assert.equal(effectiveReviewPostMode(repository,'live',list,{
    fallbackOnly:list,approval:list,allowed:list,forceDryRun:true
  }),'dry-run');
});

test('an enabled Proffera pilot can receive Draft events through fallback-only gate',()=>{
  const fallbackOnly=['ibboabdoli-ai/proffera','example/other'];
  assert.equal(pullRequestAllowedPastFallbackGate('ibboabdoli-ai/Proffera',fallbackOnly,true),true);
  assert.equal(pullRequestAllowedPastFallbackGate('ibboabdoli-ai/Proffera',fallbackOnly,false),false);
  assert.equal(pullRequestAllowedPastFallbackGate('example/other',fallbackOnly,true),false);
});

test('one-time pilot counter persists across days and blocks the eleventh batch',async()=>{
  const db=memoryDb();
  try{
    for(let n=0;n<10;n++){
      const at=Date.parse('2026-11-28T00:00:00Z')+n*86400000;
      assert.deepEqual(await reserveProfferaPilotCalls(db,2,10,at,1),{allowed:true});
    }
    assert.deepEqual(await reserveProfferaPilotCalls(db,2,10,Date.parse('2026-12-20T00:00:00Z'),1),
      {allowed:false,reason:'pilot-exhausted'});
    assert.equal(db.sql.prepare('SELECT used FROM ai_daily_limits WHERE day=?').get(PROFFERA_PILOT_KEY).used,10);
  }finally{db.sql.close();}
});

test('a multi-batch review cannot reserve beyond the remaining lifetime cap',async()=>{
  const db=memoryDb();
  try{
    assert.deepEqual(await reserveProfferaPilotCalls(db,10,10,Date.now(),8),{allowed:true});
    assert.deepEqual(await reserveProfferaPilotCalls(db,10,10,Date.now(),3),
      {allowed:false,reason:'pilot-exhausted'});
    assert.equal(db.sql.prepare('SELECT used FROM ai_daily_limits WHERE day=?').get(PROFFERA_PILOT_KEY).used,8);
  }finally{db.sql.close();}
});

test('impossible daily batch count does not consume the one-time pilot allowance',async()=>{
  const db=memoryDb();
  try{
    assert.deepEqual(await reserveProfferaPilotCalls(db,1,10,Date.now(),2),
      {allowed:false,reason:'requires-higher-cap'});
    assert.equal(db.sql.prepare('SELECT used FROM ai_daily_limits WHERE day=?').get(PROFFERA_PILOT_KEY),undefined);
  }finally{db.sql.close();}
});
