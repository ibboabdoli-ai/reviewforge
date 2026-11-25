import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claimPostgresJob,withPostgresClaim} from '../src/db-postgres.mjs';
import {claimWork,setClaimPhase,finishClaim} from '../src/claim-fence.mjs';

function fixture(mode){
  let job='queued',review=mode==='terminal'?'failed':'queued',snapshot=null,released=false,commands=[];
  const client={async query(sql){
    if(sql==='BEGIN'){snapshot=[job,review];commands.push(sql);return {rows:[]};}
    if(sql.startsWith('WITH candidate')){commands.push('claim');if(mode==='empty'||(sql.includes("r.status='queued'")&&review!=='queued'))return {rows:[]};job='running';return {rows:[{job_id:3,review_id:2,attempts:1}]};}
    if(sql.startsWith('UPDATE reviews')){commands.push('mark');if(mode==='failure')throw Error('synthetic failure');if(mode==='zero')return {rowCount:0};review='running';return {rowCount:1};}
    if(sql.startsWith('SELECT r.*')){commands.push('read');return {rows:mode==='missing'?[]:[{id:2,status:review}]};}
    if(sql==='COMMIT'){commands.push(sql);return {};}
    if(sql==='ROLLBACK'){commands.push(sql);[job,review]=snapshot;return {};}
    throw Error('unexpected query');
  },release(){released=true;}};
  return {pool:{async connect(){return client;}},state:()=>({job,review,released,commands})};
}

test('Postgres claim transaction marks both rows or rolls back (stub pool, no database)',async()=>{
  for(const mode of ['normal','empty','terminal','failure','zero','missing']){
    const f=fixture(mode);
    if(mode==='normal'){
      const value=await claimPostgresJob(f.pool,2);
      assert.equal(value.status,'running');
      assert.deepEqual(f.state(),{job:'running',review:'running',released:true,commands:['BEGIN','claim','mark','read','COMMIT']});
    }else if(['empty','terminal'].includes(mode)){
      assert.equal(await claimPostgresJob(f.pool,2),null);
      assert.deepEqual(f.state().commands,['BEGIN','claim','COMMIT']);
      assert.equal(f.state().job,'queued');
      assert.equal(f.state().released,true);
    }else{
      await assert.rejects(()=>claimPostgresJob(f.pool,2),/synthetic failure|not queued|not accessible/);
      assert.equal(f.state().job,'queued');
      assert.equal(f.state().review,'queued');
      assert.equal(f.state().commands.at(-1),'ROLLBACK');
      assert.equal(f.state().released,true);
    }
  }
});

function postgresBin(){
  if(process.platform!=='linux'||process.getuid?.()===0||!existsSync('/usr/lib/postgresql'))return null;
  return readdirSync('/usr/lib/postgresql').sort((a,b)=>Number(b)-Number(a))
    .map(v=>join('/usr/lib/postgresql',v,'bin'))
    .find(p=>existsSync(join(p,'initdb'))&&existsSync(join(p,'pg_ctl')))??null;
}
const bin=postgresBin();
test('Postgres claim is atomic across real connections on an isolated local cluster',
  {skip:bin?false:'Local PostgreSQL binaries/non-root user unavailable',timeout:90000},async()=>{
  // No DATABASE_URL or production credentials. Unix socket only, fresh fixture.
  const dir=mkdtempSync(join(tmpdir(),'rf-pg-claim-'));
  const data=join(dir,'data');
  const run=(name,args)=>execFileSync(join(bin,name),args,{timeout:30000,stdio:'pipe'});
  let started=false,pool;
  try{
    run('initdb',['-D',data,'-A','trust','--no-locale','-U','rf_fixture']);
    run('pg_ctl',['-D',data,'-l',join(dir,'server.log'),'-o',"-h '' -k "+dir,'-w','start']);
    started=true;
    const {default:pg}=await import('pg');
    pool=new pg.Pool({host:dir,port:5432,user:'rf_fixture',database:'postgres',password:'',ssl:false,max:3});
    await pool.query(`CREATE TABLE installations(id bigint PRIMARY KEY,status text);
      CREATE TABLE repositories(id bigint PRIMARY KEY,installation_id bigint,enabled int,full_name text);
      CREATE TABLE reviews(id bigint PRIMARY KEY,repository_id bigint,installation_id bigint,status text);
      CREATE TABLE jobs(id bigint PRIMARY KEY,review_id bigint UNIQUE,status text,attempts int,next_attempt_at bigint,claim_token text,claim_phase text);
      INSERT INTO installations VALUES(17,'active');
      INSERT INTO repositories VALUES(27,17,1,'fixture/repo');
      INSERT INTO reviews VALUES(1,27,17,'queued'),(2,27,17,'failed'),(3,27,17,'queued');
      INSERT INTO jobs(id,review_id,status,attempts,next_attempt_at) VALUES(11,1,'queued',0,0),(12,2,'queued',0,0),(13,3,'queued',0,0);`);
    const pair=async id=>(await pool.query('SELECT j.status AS job,r.status AS review,j.attempts FROM jobs j JOIN reviews r ON r.id=j.review_id WHERE r.id=$1',[id])).rows[0];
    const results=await Promise.all([claimPostgresJob(pool,1),claimPostgresJob(pool,1)]);
    const winners=results.filter(Boolean);
    assert.equal(winners.length,1);
    assert.equal(winners[0].status,'running');
    assert.deepEqual(await pair(1),{job:'running',review:'running',attempts:1});
    assert.equal(await claimPostgresJob(pool,2),null);
    assert.deepEqual(await pair(2),{job:'queued',review:'failed',attempts:0});
    await pool.query(`CREATE FUNCTION reject_claim() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id=3 THEN RAISE EXCEPTION 'synthetic write failure'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_claim BEFORE UPDATE OF status ON reviews FOR EACH ROW EXECUTE FUNCTION reject_claim();`);
    await assert.rejects(()=>claimPostgresJob(pool,3),/synthetic write failure/);
    assert.deepEqual(await pair(3),{job:'queued',review:'queued',attempts:0});
    await pool.query('DROP TRIGGER reject_claim ON reviews');
    assert.equal((await claimPostgresJob(pool,3)).status,'running');
    assert.deepEqual(await pair(3),{job:'running',review:'running',attempts:1});
    const adapter={withClaim:(job,work)=>withPostgresClaim(pool,job,work)};
    const first=winners[0];
    const finish=(claim,phases,status,decrement=false)=>finishClaim(adapter,claim,phases,{status,decrement},'UPDATE reviews SET status=? WHERE id=?',[status]);
    await finish(first,['ready'],'queued',true);
    const second=await claimPostgresJob(pool,1);
    assert.equal(first.attempts,second.attempts);
    assert.notEqual(first.claim_token,second.claim_token);
    await assert.rejects(()=>finish(first,['ready'],'queued'),/expired or changed/);
    await claimWork(adapter,second,['ready'],tx=>setClaimPhase(tx,second,'model_started'));
    await assert.rejects(()=>finish(second,['ready'],'queued'),/Unexpected worker claim phase/);
    await claimWork(adapter,second,['model_started'],tx=>setClaimPhase(tx,second,'model_saved'));
    await pool.query("CREATE TRIGGER reject_pair BEFORE UPDATE OF status ON reviews FOR EACH ROW WHEN (NEW.id=1) EXECUTE FUNCTION reject_claim()");
    // A trigger that rejects this specific pair, independent of the earlier claim test.
    await pool.query("CREATE OR REPLACE FUNCTION reject_claim() RETURNS trigger LANGUAGE plpgsql AS $ BEGIN IF NEW.id=1 THEN RAISE EXCEPTION 'synthetic pair failure'; END IF; RETURN NEW; END; $");
    await assert.rejects(()=>finish(second,['model_saved'],'queued'),/synthetic pair failure/);
    assert.deepEqual(await pair(1),{job:'running',review:'running',attempts:1});
    await pool.query('DROP TRIGGER reject_pair ON reviews');
    await finish(second,['model_saved'],'queued');
    const third=await claimPostgresJob(pool,1);
    await pool.query('UPDATE jobs SET next_attempt_at=$1 WHERE review_id=1',[Date.now()-1]);
    await assert.rejects(()=>claimWork(adapter,third,['ready'],tx=>setClaimPhase(tx,third,'post_started')),/expired or changed/);
  }finally{
    try{await pool?.end();}
    finally{
      // If shutdown fails, do not delete a possibly active cluster.
      if(started)run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
      rmSync(dir,{recursive:true,force:true});
    }
  }
});
