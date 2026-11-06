import {parentPort,workerData} from 'node:worker_threads';
import {openDatabase} from '../src/db.mjs';

const db=openDatabase(workerData.path);
parentPort.postMessage('ready');
const gate=new Int32Array(workerData.gate);
Atomics.wait(gate,0,0);
try{
  db.reserveReview({installationId:10,repositoryId:20,prNumber:workerData.prNumber,
    title:'Concurrent',author:'owner',headSha:workerData.headSha});
  parentPort.postMessage('created');
}catch(error){parentPort.postMessage(error.status===429?'limited':'error:'+error.message);}
finally{db.close();}
