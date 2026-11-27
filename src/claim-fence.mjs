// Claim identity is independent of the retry counter. All work passed to the
// adapter transaction must be database-only; never hold a lock across network I/O.
export function activeClaim(row,job,now=Date.now()){
  return !!row&&typeof job.claim_token==='string'&&job.claim_token.length>0&&
    row.claim_token===job.claim_token&&row.job_status==='running'&&
    row.review_status==='running'&&Number(row.next_attempt_at)>now;
}
function claimError(message,lost=false){
  return Object.assign(new Error(message),{nonRetryable:true,claimLost:lost});
}
export async function claimWork(db,job,phases,work){
  const result=await db.withClaim(job,async(tx,phase)=>{
    if(!phases.includes(phase))throw claimError('Unexpected worker claim phase');
    return work(tx,phase);
  });
  if(result===null)throw claimError('Worker claim expired or changed',true);
  return result.value;
}
export async function setClaimPhase(tx,job,phase){
  const updated=await tx.prepare("UPDATE jobs SET claim_phase=? WHERE id=? AND claim_token=? AND status='running'")
    .run(phase,job.job_id,job.claim_token);
  if(updated.changes!==1)throw claimError('Worker claim phase update lost',true);
}
export async function finishClaim(db,job,phases,{status,nextAttemptAt=0,decrement=false},reviewSql,reviewArgs){
  return claimWork(db,job,phases,async tx=>{
    const updated=await tx.prepare(`UPDATE jobs SET status=?,next_attempt_at=?,
      attempts=CASE WHEN ?=1 AND attempts>0 THEN attempts-1 ELSE attempts END,
      claim_token=NULL,claim_phase=CASE WHEN ?='queued' THEN NULL ELSE claim_phase END
      WHERE id=? AND claim_token=? AND status='running'`)
      .run(status,nextAttemptAt,decrement?1:0,status,job.job_id,job.claim_token);
    if(updated.changes!==1)throw claimError('Worker claim transition lost',true);
    const marked=await tx.prepare(reviewSql+" AND status='running'").run(...reviewArgs,job.id);
    if(marked.changes!==1)throw claimError('Worker review transition lost',true);
  });
}
