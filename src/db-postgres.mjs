// PostgreSQL adapter for Vercel/Neon. It keeps the minimal SQLite prepare/get/all/run API
// while making every operation explicitly asynchronous.
// A pooled connection URL (DATABASE_URL) is expected for serverless traffic.
let sharedPool;
function normalize(sql) {
  let i=0;
  // Placeholders are controlled literals in the server, never user-provided SQL.
  return sql
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi,'INSERT INTO')
    .replace(/datetime\('now','start of month'\)/gi,"(date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')")
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
  // Reconcile expired workers independently, without starting any paid model.
  const reconcileExpiredJobs=async()=>query(`WITH expired AS (
    UPDATE jobs SET status='failed' WHERE status='running'
      AND next_attempt_at>0 AND next_attempt_at<$1 RETURNING review_id
  ) UPDATE reviews SET status='failed', finished_at=CURRENT_TIMESTAMP,
      summary='Review worker exceeded its execution lease. No clean review verdict was produced.',
      error='Worker timed out; automatic paid replay is prohibited.'
    WHERE id IN (SELECT review_id FROM expired) AND status='running'`,[Date.now()]);
  return {
    async reserveReview({installationId,repositoryId,prNumber,title,author,headSha,manual=false,unlimited=false}){
      const client=await sharedPool.connect();
      try{
        await client.query('BEGIN');
        const owner=await client.query("SELECT i.owner_user_id FROM repositories p JOIN installations i ON i.id=p.installation_id WHERE p.id=$1 AND p.installation_id=$2 AND p.enabled=1 AND i.status='active' FOR SHARE OF p,i",[repositoryId,installationId]);
        if(!owner.rows.length)throw Object.assign(new Error('Repository is not accessible.'),{status:403});
        // Lock the billing owner, shared by all installations, before counting.
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner.rows[0].owner_user_id]);
        const existing=await client.query('SELECT r.id,m.review_id AS manual_id FROM reviews r LEFT JOIN manual_review_requests m ON m.review_id=r.id WHERE r.repository_id=$1 AND r.pr_number=$2 AND r.head_sha=$3',[repositoryId,prNumber,headSha]);
        let result;
        if(existing.rows.length)result={id:Number(existing.rows[0].id),created:false,manual:!!existing.rows[0].manual_id};
        else{
          const plan=await client.query('SELECT status FROM subscriptions WHERE user_id=$1 FOR UPDATE',[owner.rows[0].owner_user_id]);
          const status=plan.rows[0]?.status,limit=status==='active'||status==='trialing'?500:10;
          const count=await client.query("SELECT COUNT(*) AS total FROM reviews r JOIN installations i ON i.id=r.installation_id WHERE i.owner_user_id=$1 AND r.created_at >= (date_trunc('month',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')",[owner.rows[0].owner_user_id]);
          if(!unlimited && Number(count.rows[0].total)>=limit)throw Object.assign(new Error('Monthly review limit reached.'),{status:429});
          const inserted=await client.query("INSERT INTO reviews(installation_id,repository_id,pr_number,pr_title,author,head_sha,status,summary) VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING id",[installationId,repositoryId,prNumber,title,author,headSha,manual?'Manual shadow review requested; no GitHub posting.':'']);
          const id=Number(inserted.rows[0].id);
          if(manual)await client.query('INSERT INTO manual_review_requests(review_id) VALUES($1)',[id]);
          await client.query('INSERT INTO jobs(review_id) VALUES($1)',[id]);
          result={id,created:true,manual};
        }
        await client.query('COMMIT');
        return result;
      }catch(error){await client.query('ROLLBACK');throw error;}
      finally{client.release();}
    },
    async reconcileExpiredJobs(){
      const result=await reconcileExpiredJobs();
      return result.rowCount||0;
    },
    async claimJob(reviewId=null){
      if(reviewId!==null && (!Number.isSafeInteger(Number(reviewId))||Number(reviewId)<=0))
        throw new Error('Invalid review ID');
      await reconcileExpiredJobs();
      // Row locking prevents concurrent claims; worker can target one review.
      const sql=`WITH candidate AS (
        SELECT j.id FROM jobs j
        JOIN reviews r ON r.id=j.review_id
        JOIN repositories p ON p.id=r.repository_id
        JOIN installations i ON i.id=r.installation_id
        WHERE j.status='queued' AND j.next_attempt_at<=$1
          AND ($3::bigint IS NULL OR j.review_id=$3)
          AND i.status='active' AND p.enabled=1
        ORDER BY j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
      )
      UPDATE jobs j SET status='running', attempts=j.attempts+1, next_attempt_at=$2
      FROM candidate WHERE j.id=candidate.id
      RETURNING j.id AS job_id, j.review_id, j.attempts`;
      const {rows}=await sharedPool.query(sql,[Date.now(),Date.now()+5*60*1000,reviewId]);
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
