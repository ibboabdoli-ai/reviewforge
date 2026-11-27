/** Store only provider counters; token counts never imply a price. */
export function providerUsage(usage){
  if(!usage || ![usage.input_tokens,usage.output_tokens,usage.total_tokens].every(
    n=>Number.isSafeInteger(n)&&n>=0) ||
    usage.input_tokens+usage.output_tokens>usage.total_tokens)return null;
  return {inputTokens:usage.input_tokens,outputTokens:usage.output_tokens,
    totalTokens:usage.total_tokens};
}

/** A failed paid attempt has no successful batch checkpoint. Keep available
 * counters in the durable review error instead of treating it as clean.
 */
export function reviewFailureMessage(error){
  const t=error?.telemetry;
  const safeModel=typeof t?.model==='string' && /^[a-zA-Z0-9._-]{1,100}$/.test(t.model)
    ?t.model:null;
  const duration=Number.isSafeInteger(t?.durationMs) && t.durationMs>=0 &&
    t.durationMs<=3600000?t.durationMs:null;
  const u=t?.tokens;
  const tokens=u && [u.inputTokens,u.outputTokens,u.totalTokens].every(
    n=>Number.isSafeInteger(n)&&n>=0) && u.inputTokens+u.outputTokens<=u.totalTokens
    ?u:null;
  const details=safeModel||duration!==null||tokens
    ?' [model='+String(safeModel||'unknown')+'; durationMs='+String(duration??'unknown')+
      '; inputTokens='+String(tokens?.inputTokens??'unknown')+
      '; outputTokens='+String(tokens?.outputTokens??'unknown')+
      '; totalTokens='+String(tokens?.totalTokens??'unknown')+']':'';
  return String(error?.message||error).slice(0,Math.max(0,260-details.length))+details;
}
