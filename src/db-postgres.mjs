// PostgreSQL adapter for Vercel/Neon. It keeps the minimal SQLite prepare/get/all/run API
// while making every operation explicitly asynchronous.
// A pooled connection URL (DATABASE_URL) is expected for serverless traffic.
let sharedPool;
function normalize(sql) {
  let i=0;
  // Placeholders are controlled literals in the server, never user-provided SQL.
  return sql
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi,'INSERT INTO')
    .replace(/datetime\('now','start of month'\)/gi,"date_trunc('month',now())")
    .replace(/datetime\('now','-30 days'\)/gi,"now() - interval '30 days'")
    .replace(/\?/g,()=>`$${++i}`);
}
function isIgnore(sql) { return /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql); }
export function sqlForPostgres(sql){
  let out=normalize(sql);
  if(isIgnore(sql) && !/\bON\s+CONFLICT\b/i.test(out)){
    // Support RETURNING at the tail if needed; currently only used for conflict-free imports.
    const m=out.match(/\sRETURNING\s+.+$/i);
    out=(m?out.slice(0,m.index):out)+' ON CONFLICT DO NOTHING'+(m?m[0]:'');
  }
  return out;
}
export async function openPostgres(url){
  if(!url || !/^postgres(?:ql)?:\/\//i.test(url))throw new Error('Invalid DATABASE_URL');
  if(!sharedPool){
    const {default:pg}=await import('pg');
    sharedPool=new pg.Pool({connectionString:url,max:3,idleTimeoutMillis:5_000,connectionTimeoutMillis:8_000,ssl:{rejectUnauthorized:true}});
  }
  const query=async (sql,params)=>sharedPool.query(sqlForPostgres(sql),params);
  return {
    async claimJob(){
      // Requeue stale work only after the previous function has had time to expire.
      await query("UPDATE jobs SET status='queued' WHERE status='running' AND next_attempt_at<?",[Date.now()]);
      // PostgreSQL row locking prevents concurrent invocations from claiming the same PR.
      const sql=`WITH candidate AS (
        SELECT j.id FROM jobs j
        JOIN reviews r ON r.id=j.review_id
        JOIN repositories p ON p.id=r.repository_id
        JOIN installations i ON i.id=r.installation_id
        WHERE j.status='queued' AND j.next_attempt_at<=$1
          AND i.status='active' AND p.enabled=1
        ORDER BY j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE jobs j SET status='running', attempts=j.attempts+1, next_attempt_at=$2
      FROM candidate WHERE j.id=candidate.id
      RETURNING j.id AS job_id, j.review_id, j.attempts`;
      const {rows}=await sharedPool.query(sql,[Date.now(),Date.now()+5*60*1000]);
      if(!rows.length)return null;
      const job=await query(`SELECT r.*,p.full_name FROM reviews r
        JOIN repositories p ON p.id=r.repository_id WHERE r.id=$1`,[rows[0].review_id]);
      return {...job.rows[0],job_id:rows[0].job_id,attempts:rows[0].attempts};
    },
    prepare(sql){return {
      async get(...args){const {rows}=await query(sql,args);return rows[0];},
      async all(...args){const {rows}=await query(sql,args);return rows;},
      async run(...args){
        const adjusted=/^\s*INSERT\b/i.test(sql) && /\bINTO\s+(?:users|reviews)\s*\(/i.test(sql) && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING id` : sql;
        // Some INSERT statements do not have an id column: retry plain SQL in that case.
        try { const r=await query(adjusted,args);return {changes:r.rowCount||0,lastInsertRowid:r.rows[0]?.id??0}; }
        catch(err){ if(adjusted!==sql && err.code==='42703'){const r=await query(sql,args);return {changes:r.rowCount||0,lastInsertRowid:0};}throw err;}
      }
    };},
    async close(){await sharedPool.end();sharedPool=undefined;}
  };
}
