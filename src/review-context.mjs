import { posix } from 'node:path';
import { redactKnownTokens } from './reviewer.mjs';

// Deliberately small, read-only context sampler. No checkout, tool execution,
// arbitrary URLs, secret files, or user-supplied file paths.
export const MAX_CONTEXT_CHARS=12000;
const SOURCE_LIMIT=2, WORKFLOW_SOURCE_LIMIT=3, IMPORT_LIMIT=3;
const SAFE_SOURCE=/^(?:src|app|lib|tests|scripts)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
// Workflow YAML is allowed only in this fixed repository-owned directory.
// Do not permit dots in workflow basenames, hidden files or path traversal.
const SAFE_WORKFLOW=/^\.github\/workflows\/[a-zA-Z0-9_/-]+\.ya?ml$/;
const DENIED=/(^|\/)(?:\.|node_modules\/|__secrets__\/)|(?:^|\/)(?:secrets?|credentials|private-key|id_rsa)(?:[./-]|$)/i;
export function safeContextPath(path){
  if(typeof path!=='string'||path.length>=180||path.split('/').includes('..'))return false;
  // .github is a fixed, vetted prefix; the remainder still must pass DENIED.
  if(SAFE_WORKFLOW.test(path))return !DENIED.test(path.slice('.github/'.length));
  return SAFE_SOURCE.test(path)&&!DENIED.test(path);
}
// Candidate alternatives are grouped by import specifier. A syntactically
// valid .ts path is not evidence that it exists; try the other supported
// extensions (and index files) before dropping the runtime dependency.
const IMPORT_EXTENSIONS=['.ts','.tsx','.js','.jsx','.mjs','.cjs'];
const INDEX_EXTENSIONS=['.ts','.tsx','.js','.jsx'];
const MAX_IMPORT_RESOLUTION_READS=36;
function candidateImportPaths(root,{commonjs=false}={}){
  // Explicit data/native module specifiers are not extensionless JavaScript.
  // Appending .js/.ts would invent an unrelated dependency and false test link.
  if(/\.(?:json|node)$/i.test(root))return [];
  const explicit=IMPORT_EXTENSIONS.some(ext=>root.endsWith(ext));
  // Node CommonJS require('./name') searches .js, .json and .node before
  // directories, not .ts/.tsx. We can safely fetch only .js among those
  // candidates; an unknown JSON/native sibling must not justify falling back
  // to unrelated TS/JSX/index sources. Explicit .cjs stays supported.
  const options=explicit?[root]:commonjs?[root+'.js']:[
    ...IMPORT_EXTENSIONS.map(ext=>root+ext),
    ...INDEX_EXTENSIONS.map(ext=>root+'/index'+ext)
  ];
  return options.filter(safeContextPath);
}
function runtimeImportCandidates(sourcePath,sourceText){
  const matches=[...String(sourceText).matchAll(/(?:from\s*|import\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]((?:\.{1,2}\/|@\/)[^'"]+)['"]/g)];
  const found=[],seen=new Set();
  for(const match of matches.slice(0,30)){
    const specifier=match[1],commonjs=/\brequire\s*\(\s*['"]/.test(match[0]);
    if(specifier.startsWith('@/') && specifier.split('/').includes('..'))continue;
    const root=specifier.startsWith('@/')
      ?posix.normalize('src/'+specifier.slice(2))
      :posix.normalize(posix.join(posix.dirname(sourcePath),specifier));
    const options=candidateImportPaths(root,{commonjs}).filter(path=>path!==sourcePath);
    if(!options.length||seen.has(options[0]))continue;
    seen.add(options[0]);found.push(options);
  }
  return found;
}
// Public compatibility helper: report the preferred candidate path for each
// import, not a promise that the path exists in the pinned repository.
export function importedPaths(sourcePath,sourceText){
  return runtimeImportCandidates(sourcePath,sourceText).map(options=>options[0]);
}
export function sourceExcerpt(source,patch,maxChars=2700){
  if(typeof source!=='string'||!source.trim())return '';
  const lines=source.split('\n'), changed=[],hunks=[],nearHunks=new Set();
  let newLine=-1;
  // Select actual added/modified target lines before surrounding context.
  // A long header or ten unchanged lines preceding a hunk must never crowd
  // out the changed review-gate predicate from a bounded excerpt.
  for(const row of String(patch).split('\n')){
    const hunk=row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if(hunk){
      newLine=Math.max(0,Number(hunk[1])-1);
      hunks.push(newLine);
      for(let n=Math.max(0,newLine-10);n<Math.min(lines.length,newLine+23);n++)
        nearHunks.add(n);
      continue;
    }
    if(newLine<0)continue;
    // +++ inside a hunk is a valid added source line starting with ++.
    if(row.startsWith('+')){
      changed.push(newLine);newLine++;continue;
    }
    if(row.startsWith(' ')){newLine++;continue;}
    // Removed lines do not advance the new-file line number.
  }
  const selected=new Set();let reserved=0;
  const take=i=>{
    if(i<0||i>=lines.length||selected.has(i))return;
    const row='L'+(i+1)+': '+lines[i]+'\n';
    // Reserve the maximum five-character separator, even for adjacent rows.
    if(reserved+row.length+5>maxChars)return;
    selected.add(i);reserved+=row.length+5;
  };
  for(const i of changed)take(i);
  for(const i of changed)for(let n=i-2;n<=i+3;n++)take(n);
  for(const i of hunks)take(i);
  for(let i=0;i<Math.min(14,lines.length);i++)take(i);
  for(const i of [...nearHunks].sort((a,b)=>a-b))take(i);
  let text='',previous=-2;
  for(const i of [...selected].sort((a,b)=>a-b)){
    const row=(previous!==i-1?'\n...\n':'')+'L'+(i+1)+': '+lines[i]+'\n';
    if(text.length+row.length>maxChars)continue;
    text+=row;previous=i;
  }
  return redactKnownTokens(text);
}
export function projectRuleExcerpts(yaml,paths){
  // Only accept the supported, narrowly scoped subset of CodeRabbit's path
  // instructions. Other YAML is ignored rather than executed or evaluated.
  const lines=String(yaml).slice(0,16000).split('\n');
  const sections=[];
  let current=null,inside=false;
  for(const line of lines){
    const start=line.match(/^\s{4}- path:\s*["']([^"']{1,160})["']\s*$/);
    if(start){if(current)sections.push(current);current={glob:start[1],body:[]};inside=false;continue;}
    if(!current)continue;
    if(/^\s{6}instructions:\s*\|\s*$/.test(line)){inside=true;continue;}
    if(/^\s{0,3}\S/.test(line)){sections.push(current);current=null;inside=false;continue;}
    if(inside&&/^\s{8,}/.test(line))current.body.push(line.trim());
  }
  if(current)sections.push(current);
  const matches=(glob,path)=>{
    // Known GitHub project families only. No wildcard parser capable of
    // interpreting regex or arbitrary paths from a repository.
    // Workflow guidance was silently skipped: YAML does not match JS/TS types.
    // Admit only the exact vetted workflow glob and the existing safe paths.
    const types=/\.(?:ts|tsx|js|jsx)$/i.test(path);
    const workflow=SAFE_WORKFLOW.test(path)&&!DENIED.test(path.slice('.github/'.length));
    return (types && ((glob.startsWith('src/**')&&path.startsWith('src/'))||
      (glob.startsWith('tests/**')&&path.startsWith('tests/'))||
      (glob.startsWith('**/migrations/**')&&path.includes('/migrations/'))))||
      (workflow && glob==='.github/workflows/**');
  };
  const text=sections.filter(s=>paths.some(p=>matches(s.glob,p)))
    .slice(0,3).map(s=>s.body.join(' ').slice(0,1100)).filter(Boolean).join('\n');
  return redactKnownTokens(text).slice(0,2200);
}
async function fetchFile({repository,sha,path,api,token,missingPaths}){
  if(path!=='.coderabbit.yaml' && !safeContextPath(path))return null;
  if(!/^[a-f0-9]{40}$/i.test(sha))throw new Error('Invalid immutable PR SHA');
  const q=path.split('/').map(encodeURIComponent).join('/');
  try{
    const d=await api('/repos/'+repository+'/contents/'+q+'?ref='+sha,token);
    if(d?.type!=='file'||d.encoding!=='base64'||!Number.isSafeInteger(d.size)||d.size>55000||typeof d.content!=='string')return null;
    const source=Buffer.from(d.content.replace(/\s/g,''),'base64').toString('utf8');
    if(source.includes('\uFFFD')||source.includes('\0'))return null;
    return source;
  }catch(e){
    if(/^GitHub 404:/.test(String(e?.message))){
      missingPaths?.add(path); // Only a confirmed 404 means an earlier resolution choice is absent.
      return null;
    }
    throw new Error('Related context unavailable; safe review context could not be retrieved');
  }
}
/**
 * Return only bounded repository-owned text pinned to an exact PR HEAD.
 * Full changed hunks still come from GitHub's PR diff, never from this helper.
 * The model must treat excerpts and project guidance as untrusted data.
 */

export function isTestPath(path){
  return typeof path==='string' &&
    (/^(?:tests|e2e|__tests__)\//.test(path) ||
     /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path));
}
export function testImplementationPaths(testPath,testText){
  // Resolve static test imports and mocks. Never evaluate imported source.
  const found=[],seen=new Set();
  const pattern=/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\b(?:vi|jest)\.(?:mock|doMock)\(\s*|\brequire\s*\(\s*)['"]([^'"]{1,160})['"]/g;
  for(const match of String(testText).slice(0,45000).matchAll(pattern)){
    const spec=match[1];
    if(!spec.startsWith('./')&&!spec.startsWith('../')&&!spec.startsWith('@/'))continue;
    const root=spec.startsWith('@/')?posix.normalize('src/'+spec.slice(2)):
      posix.normalize(posix.join(posix.dirname(testPath),spec));
    const commonjs=/\brequire\s*\(\s*['"]/.test(match[0]);
    const safe=candidateImportPaths(root,{commonjs}).filter(p=>!isTestPath(p));
    // The same specifier may resolve to distinct implementations under
    // import() and CommonJS require(). Only collapse identical candidate lists.
    const key=safe.join('\x00');
    if(!safe.length||seen.has(key))continue;
    seen.add(key);found.push(safe);
    if(found.length>=15)break;
  }
  return found;
}
export function prioritizeBehaviorTests(testFiles,sourceFiles){
  const names=sourceFiles.map(f=>new Set(f.filename.toLowerCase().split(/[^a-z0-9]+/)
    .filter(x=>x.length>3&&!['public','components','tests','source'].includes(x))));
  const riskWords=new Set(['auth','authentication','authorization','security','privacy',
    'session','fingerprint','rate','limit','guard','permission','token',
    'payment','billing','refund','webhook','retry','idempotency','quota']);
  const risk=f=>Number(f.filename.toLowerCase().split(/[^a-z0-9]+/)
    .some(word=>riskWords.has(word)));
  const score=f=>{
    const tokens=f.filename.toLowerCase().split(/[^a-z0-9]+/);
    return Math.max(0,...names.map(words=>tokens.filter(t=>words.has(t)).length));
  };
  // Under the fixed three-test context budget, keep trust-boundary regressions
  // visible before convenience/demo tests. Stable ties use source overlap.
  return testFiles.map((f,i)=>({f,i,risk:risk(f),rank:score(f)}))
    .sort((a,b)=>b.risk-a.risk||b.rank-a.rank||a.i-b.i).map(x=>x.f);
}
export function relatedSourceExcerpt(source,maxChars=1800){
  // Bounded representation of a related implementation module; not a diff.
  const lines=String(source||'').split('\n');
  const indices=new Set();
  for(let i=0;i<Math.min(lines.length,16);i++)indices.add(i);
  // Include exported functions even if they occur below a long import block.
  for(let i=0;i<lines.length&&indices.size<100;i++){
    if(/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const)\s+[A-Za-z_$]/.test(lines[i])){
      for(let k=Math.max(0,i-2);k<Math.min(i+12,lines.length);k++)indices.add(k);
    }
  }
  let text='',last=-2;
  for(const i of [...indices].sort((a,b)=>a-b)){
    const part=(i===last+1?'':'\n...\n')+'L'+(i+1)+': '+lines[i]+'\n';
    if(text.length+part.length>maxChars)break;
    text+=part;last=i;
  }
  return redactKnownTokens(text);
}
/**
 * Bounded, source-only, SHA-pinned context. Direct runtime imports are ranked
 * ahead of test-linked implementation modules; the same diff drives findings.
 * No GitHub writes, checkouts, test execution or model calls occur here.
 */
export async function collectReviewContext({repository,sha,files,token,api}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository) ||
     repository.split('/').some(segment=>segment==='.'||segment==='..'))
    throw new Error('Invalid repository');
  if(!Array.isArray(files))throw new TypeError('Review changed-files list required');
  const changed=files.filter(f=>safeContextPath(f.filename)&&typeof f.patch==='string');
  const runtimeFiles=changed.filter(f=>!isTestPath(f.filename));
  const tests=prioritizeBehaviorTests(changed.filter(f=>isTestPath(f.filename)),runtimeFiles).slice(0,3);
  // A review gate can have multiple independent CI paths. The PR962-shaped
  // fixture proves that keeping just the first workflow hides the wakeup and
  // automerge validators from SHA-pinned supplemental source context.
  // Retain the usual two-file budget outside this narrowly scoped pattern.
  const workflows=runtimeFiles.filter(f=>f.filename.startsWith('.github/workflows/'))
    .slice(0,WORKFLOW_SOURCE_LIMIT);
  const adapter=runtimeFiles.find(f=>f.filename.startsWith('scripts/'));
  // Multiple independent workflow gates must remain visible even when there
  // is no JS adapter in the PR; retain the two-source limit for ordinary PRs.
  const sources=(workflows.length>=2 || (workflows.length===1 && adapter))
    ? [...workflows,...(adapter?[adapter]:[])]
    : runtimeFiles.slice(0,SOURCE_LIMIT);
  const missingPaths=new Set();
  const fetcher=path=>fetchFile({repository,sha,path,api,token,missingPaths});
  const [rule,...bodies]=await Promise.all([
    fetcher('.coderabbit.yaml'),...sources.map(f=>fetcher(f.filename)),
    ...tests.map(f=>fetcher(f.filename))
  ]);
  const sourceBodies=bodies.slice(0,sources.length),testBodies=bodies.slice(sources.length);
  const candidates=[],included=new Set(),links=[],desired=[],testNeeds=[];
  for(let i=0;i<sources.length;i++){
    if(!sourceBodies[i])continue;
    included.add(sources[i].filename);
    candidates.push({path:sources[i].filename,kind:'changed-file-excerpt',
      text:sourceExcerpt(sourceBodies[i],sources[i].patch,sources.length>2?1500:1800)});
  }
  // The changed runtime module is the strongest signal for a related source.
  // Test fixtures can import many mocks and must not consume every slot first.
  for(let i=0;i<sources.length;i++){
    if(!sourceBodies[i])continue;
    for(const options of runtimeImportCandidates(sources[i].filename,sourceBodies[i])){
      // A changed .tsx sibling does not prove that an extensionless import
      // resolves to it; the higher-priority .ts choice must still be checked.
      // Distinct candidate orders may not be collapsed by partial overlap.
      if(!included.has(options[0]) &&
         !desired.some(d=>d.options.length===options.length &&
           d.options.every((path,index)=>path===options[index])))
        desired.push({test:null,options});
    }
  }
  for(let i=0;i<tests.length;i++){
    if(!testBodies[i])continue;
    included.add(tests[i].filename);
    candidates.push({path:tests[i].filename,kind:'changed-test-behavior',
      text:sourceExcerpt(testBodies[i],tests[i].patch,1750)});
    for(const options of testImplementationPaths(tests[i].filename,testBodies[i])){
      // Keep each test's actual import candidates separate from runtime imports.
      // Overlap alone is not equivalent: Widget.tsx explicitly imports .tsx,
      // whereas an extensionless runtime import may resolve Widget.ts first.
      testNeeds.push({test:tests[i].filename,options});
      // A later included fallback does not prove earlier candidates are absent.
      // Probe the higher-priority options before linking an extensionless test import.
      if(included.has(options[0]))continue;
      if(!desired.some(d=>d.options.length===options.length &&
          d.options.every((path,index)=>path===options[index])))
        desired.push({test:tests[i].filename,options});
    }
  }
  let linked=0,attempts=0;
  for(const entry of desired.slice(0,9)){
    if(linked>=3||attempts>=MAX_IMPORT_RESOLUTION_READS)break;
    for(const path of entry.options){
      if(included.has(path))break; // First available option wins; do not fetch lower-priority siblings.
      if(attempts>=MAX_IMPORT_RESOLUTION_READS)break;
      attempts++;
      const body=await fetcher(path);
      if(!body){
        // A null source may be oversized or undecodable, not absent. Only a
        // pinned 404 proves that trying a lower-priority sibling is valid.
        if(!missingPaths.has(path))break;
        continue;
      }
      candidates.push({path,kind:entry.test?'test-linked-implementation':'related-import',
        text:relatedSourceExcerpt(body,1600)});
      included.add(path);linked++;
      break;
    }
  }
  // Bind relationships only to the module actually available at this SHA.
  // This also preserves links when an earlier runtime import fetched the file.
  for(const {test,options} of testNeeds){
    // Do not attach a test to a later fallback unless earlier candidates were
    // confirmed absent at this SHA. Quota exhaustion or unsafe/oversize files
    // are unknown, not 404; omit the unverified relationship instead.
    const resolved=options.find((path,index)=>included.has(path)&&
      options.slice(0,index).every(prior=>missingPaths.has(prior)));
    if(resolved)links.push({test,implementation:resolved});
  }
  const projectRules=projectRuleExcerpts(rule,changed.map(f=>f.filename));
  let used=projectRules.length;
  const snippets=[];
  for(const candidate of candidates){
    const room=MAX_CONTEXT_CHARS-used-120;
    if(room<300)break;
    const text=candidate.text.slice(0,Math.min(room,1800));
    if(!text)continue;
    snippets.push({...candidate,text});
    used+=text.length+120;
  }
  const snipped=new Set(snippets.map(s=>s.path));
  return {snippets,projectRules,sourceFiles:snippets.map(s=>s.path),
    testLinks:links.filter(l=>snipped.has(l.test)&&snipped.has(l.implementation)).slice(0,8),
    totalChars:used,headSha:sha};
}
