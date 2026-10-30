// A bounded retry policy shared by Vercel recovery and local workers.
export function retryState(attempts,now=Date.now()){
  if(!Number.isSafeInteger(attempts)||attempts<1)throw new Error('Invalid attempt count');
  const failed=attempts>=3;
  const nextAttemptAt=failed?now:now+Math.min(8,2**attempts)*30_000;
  return {failed,nextAttemptAt};
}
