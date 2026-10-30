// A bounded retry policy shared by Vercel recovery and local workers.
export function retryState(attempts,now=Date.now(),modelCallsMayHaveStarted=false){
  if(!Number.isSafeInteger(attempts)||attempts<1)throw new Error('Invalid attempt count');
  // A retry after an uncertain paid model execution can double-bill and
  // repeat an incomplete review. Only pre-model failures may be retried.
  const failed=Boolean(modelCallsMayHaveStarted)||attempts>=3;
  const nextAttemptAt=failed?now:now+Math.min(8,2**attempts)*30_000;
  return {failed,nextAttemptAt};
}
