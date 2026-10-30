import { config } from './config.mjs';
import { reviewSkillInstructions } from './review-skills.mjs';

export function addedLines(patch='') {
  const lines=new Set(); let nextLine=0;
  for(const str of patch.split('\n')) {
    const match=str.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if(match){nextLine=Number(match[1]);continue;}
    if(str.startsWith('+++')||str.startsWith('---'))continue;
    if(str.startsWith('+')) {lines.add(nextLine);nextLine++;}
    else if(str.startsWith(' '))nextLine++;
  }
  return lines;
}
export function redactKnownTokens(patch){
  return patch.replace(/sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}/g,'[REDACTED_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi,'$1[REDACTED_TOKEN]');
}
// Selection is deterministic, cost-bounded and never silently truncates a
// unified diff: a partial patch can invalidate line numbers or hide a bug.
const SKIPPED_PATH=/(^|\/)(\.env(?:\.|$)|id_rsa$)|\.(pem|key)$/i;
const GENERATED_PATH=/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.min\.js)$/i;
const MAX_FILES=35, MAX_FILE_PATCH=6500, MAX_TOTAL_PATCH=65000;
function priority(path){
  if(/(?:^|\/)(?:auth|security|billing|payments?|api|webhooks?|middleware)(?:\/|\.|-)|(?:stripe|permissions|session|checkout)/i.test(path))return 0;
  if(/(?:^|\/)(?:tests?|e2e|__tests__|docs?)(?:\/|\.)|\.(?:md|mdx)$/i.test(path))return 2;
  return 1;
}
export function selectFilesForReview(changedFiles){
  if(!Array.isArray(changedFiles))throw new TypeError('GitHub changed files must be an array');
  const coverage={totalChanged:changedFiles.length,reviewable:0,reviewed:0,excluded:0,missingPatch:0,oversized:0,limited:0,complete:true};
  const candidates=[];
  for(const [index,file] of changedFiles.entries()){
    if(!file || file.status==='removed' || typeof file.filename!=='string' || SKIPPED_PATH.test(file.filename) || GENERATED_PATH.test(file.filename)){
      coverage.excluded++;continue;
    }
    coverage.reviewable++;
    if(typeof file.patch!=='string' || !file.patch.trim()){coverage.missingPatch++;continue;}
    // Do not cut file hunks into invalid patches. Mark the review partial.
    if(file.patch.length>MAX_FILE_PATCH){coverage.oversized++;continue;}
    candidates.push({index,filename:file.filename,patch:redactKnownTokens(file.patch)});
  }
  candidates.sort((a,b)=>priority(a.filename)-priority(b.filename)||a.index-b.index);
  let used=0;
  const files=[];
  for(const f of candidates){
    if(files.length>=MAX_FILES||used+f.patch.length>MAX_TOTAL_PATCH){coverage.limited++;continue;}
    files.push({filename:f.filename,patch:f.patch});used+=f.patch.length;
  }
  coverage.reviewed=files.length;
  coverage.complete=coverage.missingPatch===0 && coverage.oversized===0 && coverage.limited===0;
  return {files,coverage};
}
// Compatibility for callers that only require the bounded payload.
export function safeFiles(files){return selectFilesForReview(files).files;}
export function coverageSummary(c){
  if(c.complete)return `Full review coverage: ${c.reviewed} eligible file(s); ${c.excluded} generated, removed or sensitive path(s) ignored.`;
  return `INCOMPLETE REVIEW: ${c.reviewed}/${c.reviewable} eligible files analyzed; ${c.missingPatch} missing patches, ${c.oversized} oversized patches, ${c.limited} capacity omissions. Unchecked changes may contain bugs.`;
}
/**
 * Plan a PR review as bounded, deterministic batches. This is separate from
 * safeFiles(), which is kept for compatibility with legacy integrations.
 *
 * Critical invariant: never discard or truncate a changed hunk and label it
 * fully reviewed. Giant hunks are split at line boundaries, with accurate
 * new-file starting line numbers for inline GitHub review anchors.
 */
export const MAX_MODEL_BATCHES = 4;
function splitUnifiedPatch(patch){
  if(!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(patch))return null;
  if(patch.length<=MAX_FILE_PATCH)return [patch];
  const lines=patch.split('\n');
  if(lines.at(-1)==='')lines.pop();
  let oldLine=0,newLine=0,seenHeader=false,startOld=0,startNew=0;
  let segment=[],length=0,oldCount=0,newCount=0;
  const result=[];
  const flush=()=>{
    if(!segment.length)return true;
    const header='@@ -'+startOld+','+oldCount+' +'+startNew+','+newCount+' @@\n';
    const part=header+segment.join('\n');
    if(part.length>MAX_FILE_PATCH)return false;
    result.push(part);segment=[];length=0;oldCount=0;newCount=0;
    return result.length<=20;
  };
  for(const line of lines){
    const match=line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if(match){
      if(!flush())return null;
      oldLine=Number(match[1]);newLine=Number(match[2]);seenHeader=true;
      startOld=oldLine;startNew=newLine;continue;
    }
    if(!seenHeader || !/^[ +\\-]/.test(line))return null;
    if(line.length>MAX_FILE_PATCH-80)return null;
    const increment=line.length+1;
    if(segment.length && length+increment>MAX_FILE_PATCH-80){
      if(!flush())return null;
      startOld=oldLine;startNew=newLine;
    }
    segment.push(line);length+=increment;
    if(line[0]===' '||line[0]==='-'){oldLine++;oldCount++;}
    if(line[0]===' '||line[0]==='+'){newLine++;newCount++;}
  }
  if(!flush())return null;
  return result.length?result:null;
}
export function planReviewBatches(changedFiles,{maxBatches=MAX_MODEL_BATCHES,maxBatchCharacters=MAX_TOTAL_PATCH}={}){
  if(!Array.isArray(changedFiles))throw new TypeError('GitHub changed files must be an array');
  if(!Number.isSafeInteger(maxBatches)||maxBatches<1||maxBatches>10)throw new RangeError('Invalid maxBatches');
  if(!Number.isSafeInteger(maxBatchCharacters)||maxBatchCharacters<MAX_FILE_PATCH||maxBatchCharacters>MAX_TOTAL_PATCH)
    throw new RangeError('Invalid model batch character budget');
  const coverage={totalChanged:changedFiles.length,reviewable:0,reviewed:0,excluded:0,
    missingPatch:0,oversized:0,limited:0,complete:true,batches:0,segments:0,reviewedSegments:0};
  const candidates=[];
  for(const [index,file] of changedFiles.entries()){
    if(!file||file.status==='removed'||typeof file.filename!=='string'
       ||SKIPPED_PATH.test(file.filename)||GENERATED_PATH.test(file.filename)){
      coverage.excluded++;continue;
    }
    coverage.reviewable++;
    if(typeof file.patch!=='string'||!file.patch.trim()){coverage.missingPatch++;continue;}
    const chunks=splitUnifiedPatch(redactKnownTokens(file.patch));
    if(!chunks){coverage.oversized++;continue;}
    coverage.segments+=chunks.length;
    candidates.push({index,filename:file.filename,chunks});
  }
  candidates.sort((a,b)=>priority(a.filename)-priority(b.filename)||a.index-b.index);
  const batches=[],seen=new Set();
  let batch=[],size=0;
  const flush=()=>{if(batch.length){batches.push(batch);batch=[];size=0;}};
  for(const file of candidates){
    let allIncluded=true;
    for(const patch of file.chunks){
      if(batch.length&&(batch.length>=MAX_FILES||size+patch.length>maxBatchCharacters))flush();
      if(batches.length>=maxBatches){coverage.limited++;allIncluded=false;continue;}
      batch.push({filename:file.filename,patch});size+=patch.length;
      coverage.reviewedSegments++;
    }
    if(allIncluded)seen.add(file.filename);
  }
  flush();
  coverage.reviewed=seen.size;
  coverage.batches=batches.length;
  coverage.complete=!coverage.missingPatch&&!coverage.oversized&&!coverage.limited;
  return {batches,coverage};
}

const severity=['critical','high','medium','low'];
export function validateFindings(raw,files) {
  const byPath=new Map(files.map(f=>[f.filename,addedLines(f.patch)]));
  const seen=new Set();const output=[];
  for(const f of (Array.isArray(raw)?raw:[]).slice(0,12)) {
    if(!f||!byPath.has(f.path)||!byPath.get(f.path).has(f.line)||!severity.includes(f.severity))continue;
    if(!Number.isFinite(f.confidence)||f.confidence<0.75||f.confidence>1)continue;
    if(typeof f.title!=='string'||typeof f.body!=='string'||f.body.length<8)continue;
    const key=f.path+':'+f.line;
    if(seen.has(key))continue;seen.add(key);
    output.push({path:f.path,line:f.line,severity:f.severity,category:String(f.category||'correctness').slice(0,35),
      title:f.title.slice(0,110),body:f.body.slice(0,900),confidence:f.confidence});
  }
  return output.slice(0,8);
}
export function localDemoReview(diff) {
  const text=String(diff).slice(0,16000);const findings=[];
  const lines=text.split('\n');
  const add=(index,severity,title,body)=>findings.push({path:'demo/sample.ts',line:index+1,severity,category:'demo heuristic',title,body,confidence:0.8});
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(/^\+/.test(line)&&/eval\s*\(/.test(line))add(i,'critical','Use of eval detected','Executing dynamic code may allow code injection. Replace eval with a safe parser.');
    if(/^\+/.test(line)&&/console\.log\(.*(token|secret|password)/i.test(line))add(i,'high','Sensitive value may be logged','Do not log credentials or secrets in application logs.');
    if(/^\+/.test(line)&&/==[^=]/.test(line)&&!/===/.test(line))add(i,'low','Loose equality operator','Prefer strict equality when types should not be coerced.');
  }
  return {summary:findings.length?`Demo rules flagged ${findings.length} possible issue(s). This is NOT an AI review.`:'Demo heuristic scan found no matching patterns. This is NOT an AI review.', findings:findings.slice(0,8)};
}
const schema={type:'object',additionalProperties:false,required:['summary','findings'],properties:{
  summary:{type:'string'},findings:{type:'array',items:{type:'object',additionalProperties:false,
    required:['path','line','severity','category','title','body','confidence'],properties:{
    path:{type:'string'},line:{type:'integer'},severity:{type:'string',enum:severity},
    category:{type:'string'},title:{type:'string'},body:{type:'string'},confidence:{type:'number'}
  }}}
}};
export async function reviewWithAI(files,{model=config.openai.model,reasoningEffort=null}={}) {
  if(!config.openai.apiKey)throw new Error('OPENAI_API_KEY is not configured; AI review was not run.');
  if(!files.length)return {summary:'No reviewable text changes found.',findings:[]};
  const input=files.map(f=>`FILE: ${f.filename}\nDIFF:\n${f.patch}`).join('\n\n');
  const res=await fetch('https://api.openai.com/v1/responses',{
    method:'POST',headers:{Authorization:`Bearer ${config.openai.apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model,store:false,max_output_tokens:reasoningEffort?6000:2000,
      ...(reasoningEffort?{reasoning:{effort:reasoningEffort}}:{}),
      instructions:reviewSkillInstructions(files),
      input, text:{format:{type:'json_schema',name:'review_result',strict:true,schema}}}),
    signal:AbortSignal.timeout(85000)
  });
  const data=await res.json();
  if(!res.ok)throw new Error(`AI request failed (${res.status}): ${(data.error?.message||'unknown').slice(0,150)}`);
  const raw=data.output_text ?? (data.output?.flatMap(o=>o.content||[]).filter(c=>c.type==='output_text').map(c=>c.text).join('') || '');
  if(!raw)throw new Error('AI response contained no review text');
  const result=JSON.parse(raw);return {summary:String(result.summary||'Review complete.').slice(0,600),findings:validateFindings(result.findings,files)};
}
