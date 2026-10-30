/**
 * Deterministic, explainable selection from pre-approved models. Diff content
 * is untrusted and never executed. Risk scoring is not a bug verdict.
 */
const HIGH_RISK=/(?:^|\/)(?:auth|authorization|security|permissions?|billing|payments?|stripe|checkout|subscriptions?|webhooks?|migrations?|database|db|middleware|api)(?:\/|\.|-|$)|(?:^|\/)(?:\.github\/workflows|supervisor|worker|queue|cron|session)(?:\/|\.|-|$)/i;
// Detect domain-sensitive work even if the filename has a compound suffix
// (for example company-directory-discovery-queue.ts in Proffera).
const DOMAIN_RISK=/(?:^|[-_./])(?:queue|queues|retry|retries|backoff|discovery|validator|validation|verify|verification|publication|concurrency|locking|transaction)(?:[-_./]|$)/i;
const COMPLEX=/\b(?:transaction|rollback|commit|FOR UPDATE|ON CONFLICT|DELETE FROM|UPDATE .* SET|verifySignature|idempotency|process\.env|secret|token|auth|csrf|permission|tenant|stripe|subscription)\b/i;
export function selectReviewModel(files,{fastModel='gpt-6-luna',deepModel='gpt-6.1-sol'}={}){
  if(!Array.isArray(files))throw new TypeError('Review files must be an array');
  let added=0,riskyFiles=0,complex=0;
  for(const f of files){
    const filename=String(f?.filename||'');
    if(HIGH_RISK.test(filename)||DOMAIN_RISK.test(filename))riskyFiles++;
    const patch=String(f?.patch||'');
    added+=patch.split('\n').filter(line=>line.startsWith('+')&&!line.startsWith('+++')).length;
    if(COMPLEX.test(patch))complex++;
  }
  const deep=riskyFiles>0||complex>0||files.length>=12||added>=160;
  return {model:deep?deepModel:fastModel,effort:deep?'high':'medium',
    tier:deep?'deep':'fast',reason:riskyFiles?'high-risk or stateful path':complex?'security or data-flow change':
       files.length>=12?'multi-file change':added>=160?'large patch':'routine change'};
}
