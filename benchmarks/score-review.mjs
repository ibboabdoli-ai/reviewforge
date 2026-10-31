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
     return c.anyEvidence.some(word=>evidence.includes(word.toLowerCase()));
   });
   if(index>=0){selected.add(index);matched++;}
   return {id:c.id,detected:index>=0};
 });
 return {referenceCount:cases.length,detected:matched,
  missed:cases.filter(x=>!x.detected).map(x=>x.id),
  recall:cases.length?matched/cases.length:0,
  unmatchedFindings:found.length-selected.size,cases};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const args=process.argv.slice(2);
 const named=args[0]==='--pr';
 const pr=named?args[1]:'953';
 if(!['944','953'].includes(pr)||args.length>(named?3:1)){
   console.error('Usage: node benchmarks/score-review.mjs [--pr 944|953] [findings.json]');
   process.exitCode=2;
 }else{
   const gold=JSON.parse(readFileSync(new URL('./proffera-pr'+pr+'-gold.json',import.meta.url),'utf8'));
   const path=named?args[2]:args[0];
   const actual=path ? JSON.parse(readFileSync(path,'utf8')):[];
   const findings=Array.isArray(actual)?actual:actual.findings||[];
   console.log(JSON.stringify(scoreReviewQuality(gold,findings),null,2));
 }
}
