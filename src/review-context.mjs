import { posix } from 'node:path';
import { redactKnownTokens } from './reviewer.mjs';

// Deliberately small, read-only context sampler. No checkout, tool execution,
// arbitrary URLs, secret files, or user-supplied file paths.
export const MAX_CONTEXT_CHARS=12000;
const SOURCE_LIMIT=2, IMPORT_LIMIT=3;
const SAFE_SOURCE=/^(?:src|app|lib|tests)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const DENIED=/(^|\/)(?:\.|node_modules\/|__secrets__\/)|(?:^|\/)(?:secrets?|credentials|private-key|id_rsa)(?:[./-]|$)/i;
export function safeContextPath(path){
  return typeof path==='string' && path.length<180 && SAFE_SOURCE.test(path)
    && !path.split('/').includes('..') && !DENIED.test(path);
}
export function importedPaths(sourcePath,sourceText){
  const matches=[...String(sourceText).matchAll(/(?:from\s*|import\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)];
  const found=[];
  for(const [,specifier] of matches.slice(0,30)){
    const root=posix.normalize(posix.join(posix.dirname(sourcePath),specifier));
    for(const path of (/\.[a-z]+$/i.test(root)?[root]:[root+'.ts',root+'.tsx',root+'.js',root+'/index.ts'])){
      if(safeContextPath(path) && path!==sourcePath && !found.includes(path)){
        found.push(path);break;
      }
    }
  }
  return found;
}
export function sourceExcerpt(source,patch,maxChars=2700){
  if(typeof source!=='string'||!source.trim())return '';
  const lines=source.split('\n'), wanted=new Set();
  // Include beginning of each module for imports and major declarations.
  for(let i=0;i<Math.min(14,lines.length);i++)wanted.add(i);
  for(const m of String(patch).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/gm)){
    const i=Math.max(0,Number(m[1])-1);
    for(let n=Math.max(0,i-10);n<Math.min(lines.length,i+23);n++)wanted.add(n);
  }
  const sorted=[...wanted].sort((a,b)=>a-b);
  const result=[];let used=0,previous=-2;
  for(const i of sorted){
    const row=(previous!==i-1?'\n...\n':'')+'L'+(i+1)+': '+lines[i]+'\n';
    if(used+row.length>maxChars)break;
    result.push(row);used+=row.length;previous=i;
  }
  return redactKnownTokens(result.join(''));
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
    const types=/\.(?:ts|tsx|js|jsx)$/i.test(path);
    return types && ((glob.startsWith('src/**')&&path.startsWith('src/'))||
      (glob.startsWith('tests/**')&&path.startsWith('tests/'))||
      (glob.startsWith('.github/workflows/**')&&path.startsWith('.github/workflows/'))||
      (glob.startsWith('**/migrations/**')&&path.includes('/migrations/')));
  };
  const text=sections.filter(s=>paths.some(p=>matches(s.glob,p)))
    .slice(0,3).map(s=>s.body.join(' ').slice(0,1100)).filter(Boolean).join('\n');
  return redactKnownTokens(text).slice(0,2200);
}
async function fetchFile({repository,sha,path,api,token}){
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
    if(/^GitHub 404:/.test(String(e?.message)))return null;
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
  const pattern=/(?:\bfrom\s*|\bimport\s*\(\s*|\b(?:vi|jest)\.(?:mock|doMock)\(\s*|\brequire\(\s*)['"]([^'"]{1,160})['"]/g;
  for(const match of String(testText).slice(0,45000).matchAll(pattern)){
    const spec=match[1];
    if(!spec.startsWith('./')&&!spec.startsWith('../')&&!spec.startsWith('@/'))continue;
    const root=spec.startsWith('@/')?posix.normalize('src/'+spec.slice(2)):
      posix.normalize(posix.join(posix.dirname(testPath),spec));
    const paths=/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(root)?[root]:
      ['.ts','.tsx','.js','.jsx','.mjs'].map(ext=>root+ext);
    const safe=paths.filter(p=>safeContextPath(p)&&!isTestPath(p));
    if(!safe.length||seen.has(root))continue;
    seen.add(root);found.push(safe);
    if(found.length>=15)break;
  }
  return found;
}
export function prioritizeBehaviorTests(testFiles,sourceFiles){
  const names=sourceFiles.map(f=>new Set(f.filename.toLowerCase().split(/[^a-z0-9]+/)
    .filter(x=>x.length>3&&!['public','components','tests','source'].includes(x))));
  const score=f=>{
    const tokens=f.filename.toLowerCase().split(/[^a-z0-9]+/);
    return Math.max(0,...names.map(words=>tokens.filter(t=>words.has(t)).length));
  };
  return testFiles.map((f,i)=>({f,i,rank:score(f)}))
    .sort((a,b)=>b.rank-a.rank||a.i-b.i).map(x=>x.f);
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
 * Bounded, source-only, SHA-pinned context. Test imports are ranked ahead of
 * unrelated direct imports; exactly the same diff drives actual findings.
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
  const sources=runtimeFiles.slice(0,2);
  const fetcher=path=>fetchFile({repository,sha,path,api,token});
  const [rule,...bodies]=await Promise.all([
    fetcher('.coderabbit.yaml'),...sources.map(f=>fetcher(f.filename)),
    ...tests.map(f=>fetcher(f.filename))
  ]);
  const sourceBodies=bodies.slice(0,sources.length),testBodies=bodies.slice(sources.length);
  const candidates=[],included=new Set(),links=[],desired=[];
  for(let i=0;i<sources.length;i++){
    if(!sourceBodies[i])continue;
    included.add(sources[i].filename);
    candidates.push({path:sources[i].filename,kind:'changed-file-excerpt',
      text:sourceExcerpt(sourceBodies[i],sources[i].patch,1800)});
  }
  for(let i=0;i<tests.length;i++){
    if(!testBodies[i])continue;
    included.add(tests[i].filename);
    candidates.push({path:tests[i].filename,kind:'changed-test-behavior',
      text:sourceExcerpt(testBodies[i],tests[i].patch,1750)});
    for(const options of testImplementationPaths(tests[i].filename,testBodies[i])){
      const already=options.find(path=>included.has(path));
      if(already)links.push({test:tests[i].filename,implementation:already});
      else if(!desired.some(d=>d.options[0]===options[0]))
        desired.push({test:tests[i].filename,options});
    }
  }
  // Keep production import context when the selected tests have no resolvable
  // local implementation links (for example a test built entirely on mocks).
  if(desired.length<3){
    for(let i=0;i<sources.length;i++){
      if(!sourceBodies[i])continue;
      for(const path of importedPaths(sources[i].filename,sourceBodies[i])){
        if(!included.has(path)&&!desired.some(d=>d.options.includes(path)))
          desired.push({test:null,options:[path]});
      }
    }
  }
  let linked=0;
  for(const entry of desired.slice(0,9)){
    if(linked>=3)break;
    for(const path of entry.options.slice(0,4)){
      if(included.has(path))continue;
      const body=await fetcher(path);
      if(!body)continue;
      candidates.push({path,kind:entry.test?'test-linked-implementation':'related-import',
        text:relatedSourceExcerpt(body,1600)});
      included.add(path);linked++;
      if(entry.test)links.push({test:entry.test,implementation:path});
      break;
    }
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
