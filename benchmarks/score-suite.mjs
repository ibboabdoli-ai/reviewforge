import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {scoreReviewQuality} from './score-review.mjs';

// Historical, read-only, user-authorized quality evaluation.
// No model calls, repository access, GitHub writes, or hidden retrials.
export const OBSERVED_PRS=[944,949,953];

export function scoreObservedSuite(references,history){
 if(!history||!Array.isArray(history.entries))throw new TypeError('Expected archived reviews');
 const rows=[],seenReviews=new Set(),seenPrs=new Set();
 for(const pr of OBSERVED_PRS){
   const gold=references[pr],entry=history.entries.find(r=>r.pr===pr);
   if(!gold||!entry||!Array.isArray(entry.findings)||
      gold.pr!==pr||entry.pr!==pr||gold.repository!==history.repository||
      gold.headSha!==entry.headSha||entry.status!=='completed'||entry.posted!==0||
      seenReviews.has(entry.reviewId)||seenPrs.has(pr))
     throw new Error('Incomplete, duplicate or SHA-mismatched historical quality evidence: PR '+pr);
   seenReviews.add(entry.reviewId);seenPrs.add(pr);
   const score=scoreReviewQuality(gold,entry.findings);
   rows.push({
     pr,headSha:entry.headSha,reviewId:entry.reviewId,
     model:entry.model,method:entry.method,
     referenceCases:score.referenceCount,matchedCases:score.detected,
     missedCases:score.missed,acceptedFindings:entry.findings.length,
     unmatchedAcceptedFindings:score.unmatchedFindings,
     unscoredReferenceCandidates:gold.unscored?.length||0,
     matchedCaseRatio:score.recall
   });
 }
 const totals=rows.reduce((v,r)=>({
   referenceCases:v.referenceCases+r.referenceCases,
   matchedCases:v.matchedCases+r.matchedCases,
   acceptedFindings:v.acceptedFindings+r.acceptedFindings,
   unmatchedAcceptedFindings:v.unmatchedAcceptedFindings+r.unmatchedAcceptedFindings
 }),{referenceCases:0,matchedCases:0,acceptedFindings:0,unmatchedAcceptedFindings:0});
 return {
   status:'retrospective-only',prs:rows.length,rows,totals,
   scope:'Historical comparison of three non-identical model/method versions and selected, manually triaged references. Not blind testing; 944 references were identified after the model run. The ratio is NOT an estimated production recall, false-positive rate or proof ReviewForge outperforms CodeRabbit. No model calls.'
 };
}

export function loadArchivedSuite(){
 const references={};
 for(const pr of OBSERVED_PRS)
   references[pr]=JSON.parse(readFileSync(new URL('./proffera-pr'+pr+'-gold.json',import.meta.url),'utf8'));
 const history=JSON.parse(readFileSync(new URL('./observed-reviewforge.json',import.meta.url),'utf8'));
 return scoreObservedSuite(references,history);
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])
 console.log(JSON.stringify(loadArchivedSuite(),null,2));
