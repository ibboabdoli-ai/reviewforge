import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {scoreReviewQuality} from './score-review.mjs';

export const gold=JSON.parse(readFileSync(
  new URL('./sandbox-mixed-blind-20261102-gold.json',import.meta.url),'utf8'));

export function scoreMixedBlindReview(record){
  if(!record || typeof record!=='object' ||
     record.repository!==gold.targetRepository ||
     record.pr_number!==gold.targetPr ||
     record.head_sha!==gold.targetHeadSha ||
     record.status!=='completed' ||
     Number(record.posted)!==0 ||
     !Array.isArray(record.findings)){
    throw new Error('Expected a completed, no-post review of the exact registered PR and HEAD');
  }
  const scored=scoreReviewQuality(gold,record.findings);
  const cleanPaths=new Set(gold.cleanControls.map(c=>c.path));
  const controlCandidates=record.findings.filter(f=>cleanPaths.has(f.path));
  return {
    benchmark:gold.benchmarkId,headSha:gold.targetHeadSha,
    primaryReferenceCount:scored.referenceCount,
    primaryMatched:scored.detected,
    primaryMissed:scored.missed,
    acceptedFindings:record.findings.length,
    unscoredFindings:scored.unmatchedFindings,
    cleanControlFindingCandidates:controlCandidates.map(f=>({
      path:f.path,line:f.line,title:String(f.title||'').slice(0,180)
    })),
    status:'MANUAL_TRIAGE_REQUIRED',
    warning:'Unmatched findings and clean-control candidates require independent validation; do not count them automatically as false positives. Single synthetic PR is not a population statistic.'
  };
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  if(process.argv.length!==3){
    console.error('Usage: node benchmarks/score-mixed-blind.mjs <sanitized-review-record.json>');
    process.exitCode=2;
  }else{
    const record=JSON.parse(readFileSync(process.argv[2],'utf8'));
    console.log(JSON.stringify(scoreMixedBlindReview(record),null,2));
  }
}
