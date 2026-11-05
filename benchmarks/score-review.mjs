import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

export function scoreReviewQuality(reference,found){
 if(!reference||!Array.isArray(reference.cases)||!Array.isArray(found))
   throw new TypeError('Expected benchmark cases and findings');
 const selected=new Set();
 let matched=0;
 const cases=reference.cases.map(c=>{
   const index=found.findIndex((f,i)=>{
     if(selected.has(i)||f.path!==c.path||!Number.isInteger(f.line)||
       f.line<c.lineMin||f.line>c.lineMax)return false;
     const evidence=(String(f.title||'')+' '+String(f.body||'')).toLowerCase();
     const groups=Array.isArray(c.evidenceGroups)?c.evidenceGroups:null;
     if(groups){
       // Grouped evidence requires separate facets of the same defect:
       // location alone or a single generic word must not score as detected.
       return groups.length>0&&groups.every(group=>Array.isArray(group)&&group.length>0&&
         group.some(phrase=>typeof phrase==='string'&&phrase.length>=3&&
           evidence.includes(phrase.toLowerCase())));
     }
     return Array.isArray(c.anyEvidence)&&c.anyEvidence.some(word=>
       typeof word==='string'&&word.length>=3&&evidence.includes(word.toLowerCase()));
   });
   if(index>=0){selected.add(index);matched++;}
   return {id:c.id,detected:index>=0};
 });
 return {referenceCount:cases.length,detected:matched,
  missed:cases.filter(x=>!x.detected).map(x=>x.id),
  recall:cases.length?matched/cases.length:0,
  unmatchedFindings:found.length-selected.size,cases};
}

/**
 * Optional strict scorer for like-for-like, immutable PR-head comparisons.
 * Legacy scoreReviewQuality stays unchanged for synthetic standalone fixtures.
 * Never treat findings from another commit (or repository/PR) as recall.
 */
export function scoreReviewQualitySameHead(reference,snapshot){
 if(!reference||!snapshot||Array.isArray(snapshot)||typeof snapshot!=='object'||
   !Array.isArray(snapshot.findings)||
   typeof snapshot.headSha!=='string'||!/^[0-9a-f]{40}$/i.test(snapshot.headSha)||
   reference.repository!==snapshot.repository || reference.pr!==snapshot.pr ||
   String(reference.headSha||'').toLowerCase()!==snapshot.headSha.toLowerCase())
   throw new Error('Benchmark requires same PR and HEAD SHA; refusing cross-commit comparison');
 return scoreReviewQuality(reference,snapshot.findings);
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const args=process.argv.slice(2);
 const named=args[0]==='--pr';
 const pr=named?args[1]:'953';
 if(!['944','949','953','962'].includes(pr)||args.length>(named?3:1)){
   console.error('Usage: node benchmarks/score-review.mjs [--pr 944|949|953|962] [findings.json]');
   process.exitCode=2;
 }else{
   const path=named?args[2]:args[0];
   // The PR962 gold set is commit-bound; an unlabeled list or omitted
   // snapshot could accidentally count a later commit as recovered recall.
   if(pr==='962'&&!path){
     console.error('PR962 requires a JSON snapshot with repository, pr, headSha and findings.');
     process.exitCode=2;
   }else{
     try{
       const gold=JSON.parse(readFileSync(new URL('./proffera-pr'+pr+'-gold.json',import.meta.url),'utf8'));
       const actual=path ? JSON.parse(readFileSync(path,'utf8')):[];
       const score=pr==='962'
         ?scoreReviewQualitySameHead(gold,actual)
         :scoreReviewQuality(gold,Array.isArray(actual)?actual:actual.findings||[]);
       console.log(JSON.stringify(score,null,2));
     }catch(error){
       console.error('Benchmark rejected: '+String(error?.message||error).slice(0,180));
       process.exitCode=2;
     }
   }
 }
}
