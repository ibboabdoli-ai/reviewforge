/** Observe close/errors immediately after spawn and return bounded cleanup.
 * Kill errors are not proof of exit. Remove files only after close (or an
 * already exited child); retain them and report failure if forced shutdown fails.
 */
export function trackChild(child,remove,{graceMs=2000,forceMs=2000}={}){
  let closed=child.exitCode!==null||child.signalCode!==null;
  const errors=[];
  let wake;
  const onClose=()=>{closed=true;wake?.();};
  const onError=error=>{errors.push(error);};
  child.once('close',onClose);child.on('error',onError);
  /** Wait for close up to the deadline without turning an error into an exit. */
  const wait=ms=>closed?Promise.resolve():new Promise(resolve=>{
    const timer=setTimeout(()=>{wake=null;resolve();},ms);
    wake=()=>{clearTimeout(timer);wake=null;resolve();};
  });
  /** Attempt shutdown, then cleanup; preserve a prior test failure if supplied. */
  return async function cleanup(primaryError){
    try{
      for(const [signal,deadline] of [['SIGTERM',graceMs],['SIGKILL',forceMs]]){
        if(closed)break;
        try{child.kill(signal);}catch(error){errors.push(error);}
        await wait(deadline);
      }
      if(!closed){child.unref();throw new Error('Child did not close after forced shutdown; temporary files retained');}
      remove();
      if(errors.length)throw new AggregateError(errors,'Child process errors during test or cleanup');
    }catch(error){
      if(primaryError){primaryError.cleanupError=error;return;}
      throw error;
    }finally{
      child.removeListener('close',onClose);
      // Keep an error handler if termination failed: a late error must not crash the runner.
      if(closed)child.removeListener('error',onError);
    }
  };
}
