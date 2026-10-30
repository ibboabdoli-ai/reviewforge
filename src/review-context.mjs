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
export async function collectReviewContext({repository,sha,files,token,api}){
  if(!/^[\w.-]+\/[\w.-]+$/.test(repository) ||
     repository.split('/').some(segment=>segment==='.'||segment==='..'))
    throw new Error('Invalid repository');
  if(!Array.isArray(files))throw new TypeError('Review changed-files list required');
  const changed=files.filter(f=>safeContextPath(f.filename) && typeof f.patch==='string');
  const sourceFiles=changed.filter(f=>!/\.test\.[jt]sx?$|^tests\//.test(f.filename))
    .slice(0,SOURCE_LIMIT);
  const fetcher=path=>fetchFile({repository,sha,path,api,token});
  const [ruleFile,...sourceBodies]=await Promise.all([
    fetcher('.coderabbit.yaml'), ...sourceFiles.map(f=>fetcher(f.filename))
  ]);
  const candidates=[];
  for(let i=0;i<sourceFiles.length;i++){
    const file=sourceFiles[i],body=sourceBodies[i];
    if(!body)continue;
    const extra=sourceExcerpt(body,file.patch);
    if(extra)candidates.push({path:file.filename,kind:'changed-file-excerpt',text:extra});
  }
  const imports=[];
  for(let i=0;i<sourceFiles.length;i++){
    const body=sourceBodies[i];
    if(!body)continue;
    for(const path of importedPaths(sourceFiles[i].filename,body)){
      if(changed.some(c=>c.filename===path)||imports.includes(path))continue;
      imports.push(path);
    }
  }
  const other=imports.slice(0,IMPORT_LIMIT);
  const bodies=await Promise.all(other.map(fetcher));
  for(let i=0;i<other.length;i++){
    if(!bodies[i])continue;
    candidates.push({path:other[i],kind:'related-import',text:redactKnownTokens(bodies[i].slice(0,3100))});
  }
  const projectRules=projectRuleExcerpts(ruleFile,changed.map(f=>f.filename));
  let used=projectRules.length;
  const snippets=[];
  for(const c of candidates){
    const room=MAX_CONTEXT_CHARS-used-120;
    if(room<300)break;
    const text=c.text.slice(0,Math.min(3200,room));
    snippets.push({...c,text});
    used+=text.length+120;
  }
  return {snippets,projectRules,sourceFiles:snippets.map(s=>s.path),
    totalChars:used,headSha:sha};
}
