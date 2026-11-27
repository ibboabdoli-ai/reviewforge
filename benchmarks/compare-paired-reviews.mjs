import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const SHA=/^[0-9a-f]{40}$/i;
const severity=new Set(['critical','high','medium','low']);
const positive=n=>Number.isSafeInteger(n)&&n>=0;
function reject(message){throw new Error('Paired comparison rejected: '+message);}
function checkSnapshot(snapshot,tool){
  if(!snapshot || snapshot.tool!==tool || typeof snapshot.repository!=='string' ||
     !Number.isSafeInteger(snapshot.pr) || snapshot.pr<1 || !SHA.test(snapshot.headSha||'') ||
     !['completed','partial','failed','superseded','skipped'].includes(snapshot.status) ||
     !Array.isArray(snapshot.findings))reject('invalid '+tool+' snapshot');
  const ids=new Set();
  for(const finding of snapshot.findings){
    if(!finding || typeof finding.id!=='string' || !finding.id || ids.has(finding.id) ||
       typeof finding.path!=='string' || !positive(finding.line) || finding.line<1 ||
       !severity.has(finding.severity))reject('invalid or duplicate '+tool+' finding');
    ids.add(finding.id);
  }
  return ids;
}
function fullCoverage(snapshot){
  const c=snapshot.coverage;
  return snapshot.status==='completed' && c?.complete===true && positive(c.eligible) &&
    c.eligible===c.analyzed && Array.isArray(c.excluded) && c.excluded.length===0;
}
function usage(snapshot){
  const u=snapshot.usage;
  return u && [u.inputTokens,u.outputTokens,u.totalTokens].every(positive) &&
    u.inputTokens+u.outputTokens<=u.totalTokens
    ?{inputTokens:u.inputTokens,outputTokens:u.outputTokens,totalTokens:u.totalTokens}:null;
}
function metrics(snapshot){
  return {status:snapshot.status,coverage:snapshot.coverage||null,
    durationMs:positive(snapshot.durationMs)?snapshot.durationMs:null,
    tokens:usage(snapshot),
    // A real provider invoice may be attached later; token counts alone are not a price.
    billedCost:snapshot.billedCost &&
      Number.isFinite(snapshot.billedCost.amount) && snapshot.billedCost.amount>=0 &&
      /^[A-Z]{3}$/.test(snapshot.billedCost.currency||'')
      ?snapshot.billedCost:null,
    error:snapshot.status==='failed'?String(snapshot.error||'unspecified failure').slice(0,300):null};
}

/** Compare independently completed exact-head reviews after code-backed adjudication.
 * This module is offline and never imported into the reviewer or its prompt.
 */
export function comparePairedReviews(reviewforge,coderabbit,adjudication){
  const rfIds=checkSnapshot(reviewforge,'reviewforge');
  const crIds=checkSnapshot(coderabbit,'coderabbit');
  if(reviewforge.repository.toLowerCase()!==coderabbit.repository.toLowerCase() ||
     reviewforge.pr!==coderabbit.pr ||
     reviewforge.headSha.toLowerCase()!==coderabbit.headSha.toLowerCase())
    reject('repository, PR and exact HEAD SHA must match');
  const report={repository:reviewforge.repository,pr:reviewforge.pr,
    headSha:reviewforge.headSha.toLowerCase(),
    reviewforge:metrics(reviewforge),coderabbit:metrics(coderabbit)};
  if(!fullCoverage(reviewforge)||!fullCoverage(coderabbit))
    return {...report,comparable:false,reason:'Both reviews need completed, verified full-file coverage.',quality:null};
  if(!adjudication || !Array.isArray(adjudication.issues))
    reject('code-backed issue adjudication is required');
  const seenRf=new Set(),seenCr=new Set(),issues=new Set();
  const quality={sharedImportant:[],missedImportant:[],extraValid:[],
    falseWarnings:{reviewforge:[],coderabbit:[]},
    commonValid:[],reviewforgeMisses:[],coderabbitMisses:[]};
  for(const issue of adjudication.issues){
    if(!issue || typeof issue.id!=='string' || !issue.id || issues.has(issue.id) ||
       typeof issue.valid!=='boolean' || !severity.has(issue.severity) ||
       typeof issue.evidence!=='string' || issue.evidence.trim().length<12 ||
       !Array.isArray(issue.reviewforgeFindingIds) || !Array.isArray(issue.coderabbitFindingIds) ||
       issue.reviewforgeFindingIds.length+issue.coderabbitFindingIds.length===0)
      reject('each issue needs a unique ID, validity, severity and code evidence');
    issues.add(issue.id);
    for(const [list,allowed,seen,tool] of [
      [issue.reviewforgeFindingIds,rfIds,seenRf,'ReviewForge'],
      [issue.coderabbitFindingIds,crIds,seenCr,'CodeRabbit']]){
      for(const id of list){
        if(!allowed.has(id)||seen.has(id))reject('unknown or reused '+tool+' finding ID');
        seen.add(id);
      }
    }
    const rf=issue.reviewforgeFindingIds.length>0,cr=issue.coderabbitFindingIds.length>0;
    if(!issue.valid){
      if(rf)quality.falseWarnings.reviewforge.push(issue.id);
      if(cr)quality.falseWarnings.coderabbit.push(issue.id);
    }else{
      if(rf&&cr)quality.commonValid.push(issue.id);
      if(!rf&&cr)quality.reviewforgeMisses.push(issue.id);
      if(rf&&!cr)quality.coderabbitMisses.push(issue.id);
      if(['critical','high'].includes(issue.severity)){
        if(rf&&cr)quality.sharedImportant.push(issue.id);
        if(!rf&&cr)quality.missedImportant.push(issue.id);
      }
      if(rf&&!cr)quality.extraValid.push(issue.id);
    }
  }
  if(seenRf.size!==rfIds.size || seenCr.size!==crIds.size)
    reject('every finding must be assigned to exactly one code-checked issue');
  return {...report,comparable:true,quality};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{
    if(process.argv.length!==5)throw new Error('Usage: node benchmarks/compare-paired-reviews.mjs reviewforge.json coderabbit.json adjudication.json');
    const inputs=process.argv.slice(2).map(path=>JSON.parse(readFileSync(path,'utf8')));
    console.log(JSON.stringify(comparePairedReviews(...inputs),null,2));
  }catch(error){console.error(String(error.message||error));process.exitCode=2;}
}
