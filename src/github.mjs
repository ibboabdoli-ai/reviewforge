import { createSign } from 'node:crypto';
import { config } from './config.mjs';
import { decrypt, encrypt } from './security.mjs';

const API='https://api.github.com';
const VERSION='2026-03-10';
export async function githubApi(path,token,{method='GET',body}={}) {
  const res=await fetch(API+path,{
    method, headers:{'Authorization':`Bearer ${token}`,'Accept':'application/vnd.github+json',
      'X-GitHub-Api-Version':VERSION,'User-Agent':'ReviewForge-MVP/0.1', ...(body?{'Content-Type':'application/json'}:{})},
    body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(20000)
  });
  const text=await res.text(); let data;
  try { data=text?JSON.parse(text):{}; }catch {data={message:text.slice(0,300)};}
  if(!res.ok) throw new Error(`GitHub ${res.status}: ${(data.message||'request failed').slice(0,300)}`);
  return data;
}
export async function githubOAuthCode(code) {
  const form=new URLSearchParams({client_id:config.github.clientId,client_secret:config.github.clientSecret,code});
  const res=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(15000)});
  const data=await res.json(); if(!res.ok||!data.access_token) throw new Error('GitHub OAuth exchange failed: '+(data.error||res.status)); return data;
}
export async function persistUserToken(db,userId,data) {
  await db.prepare('UPDATE users SET token_cipher=?,refresh_cipher=?,token_expires_at=? WHERE id=?').run(
    encrypt(data.access_token,config.sessionSecret),data.refresh_token?encrypt(data.refresh_token,config.sessionSecret):null,
    data.expires_in?Date.now()+data.expires_in*1000:0,userId);
}
export async function githubUserToken(db,user) {
  if(!user.token_cipher) throw new Error('GitHub authorization missing; sign in again.');
  if (!user.token_expires_at || user.token_expires_at>Date.now()+60000) return decrypt(user.token_cipher,config.sessionSecret);
  if(!user.refresh_cipher) throw new Error('GitHub token expired; please sign in again.');
  const form=new URLSearchParams({client_id:config.github.clientId,client_secret:config.github.clientSecret,
    grant_type:'refresh_token',refresh_token:decrypt(user.refresh_cipher,config.sessionSecret)});
  const res=await fetch('https://github.com/login/oauth/access_token',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:form,signal:AbortSignal.timeout(15000)});
  const data=await res.json(); if(!res.ok||!data.access_token) throw new Error('GitHub authorization expired; please sign in again.');
  await persistUserToken(db,user.id,data); return data.access_token;
}
export function githubAppJwt() {
  if(!config.github.privateKey||!config.github.appId) throw new Error('GitHub App credentials not configured');
  const issued=Math.floor(Date.now()/1000)-60, expires=issued+540;
  const header=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({iat:issued,exp:expires,iss:config.github.appId})).toString('base64url');
  const str=header+'.'+payload;
  const signer=createSign('RSA-SHA256'); signer.update(str); signer.end();
  return str+'.'+signer.sign(config.github.privateKey).toString('base64url');
}
export async function installationToken(installationId) {
  const data=await githubApi(`/app/installations/${Number(installationId)}/access_tokens`,githubAppJwt(),{method:'POST'});
  return data.token;
}
export async function installationsForUser(db,user,{api=githubApi,userToken=githubUserToken}={}) {
  const token=await userToken(db,user);
  const result=[];
  for(let page=1;page<=5;page++) {
    const data=await api(`/user/installations?per_page=100&page=${page}`,token);
    if(!Array.isArray(data.installations))throw new Error('Invalid GitHub installation list');
    result.push(...data.installations);
    if(data.installations.length<100)return {token,installations:result};
  }
  throw new Error('GitHub installation list exceeded pagination bound');
}
/** Live user-to-server GitHub access, never installation ownership, gates reads. */
export async function authorizedRepositoryIds(db,user,{api=githubApi,userToken=githubUserToken}={}){
  // PostgreSQL returns BIGINT identifiers as strings; SQLite returns numbers.
  if(!Number.isSafeInteger(Number(user?.id))||Number(user?.id)<=0||
     !Number.isSafeInteger(Number(user?.github_id))||Number(user?.github_id)<=0)return new Set();
  const current=await db.prepare('SELECT * FROM users WHERE id=? AND github_id=?').get(user.id,user.github_id);
  if(!current)return new Set();
  const {token,installations}=await installationsForUser(db,current,{api,userToken});
  const active=await db.prepare("SELECT id FROM installations WHERE status='active'").all();
  const activeIds=new Set(active.map(row=>Number(row.id)));
  const ids=new Set();
  for(const inst of installations){
    if(!activeIds.has(Number(inst.id)))continue;
    for(let page=1;page<=5;page++){
      const data=await api(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,token);
      if(!Array.isArray(data.repositories))throw new Error('Invalid GitHub repository list');
      for(const repo of data.repositories)if(Number.isSafeInteger(repo.id))ids.add(repo.id);
      if(data.repositories.length<100)break;
      if(page===5)throw new Error('GitHub repository list exceeded pagination bound');
    }
  }
  return ids;
}
export async function syncInstallations(db,user,{api=githubApi,userToken=githubUserToken}={}) {
  const {token,installations}=await installationsForUser(db,user,{api,userToken});
  let linked=0,repoCount=0;
  for(const inst of installations) {
    // The first linked user remains the billing owner, not the only member.
    await db.prepare(`INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(?,?,?,'active')
      ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login,status='active'`).run(inst.id,user.id,inst.account?.login||'unknown');
    linked++;
    // A member's visibility cannot disable repositories for other members.
    for(let page=1;page<=5;page++) {
      const data=await api(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,token);
      if(!Array.isArray(data.repositories))throw new Error('Invalid GitHub repository list');
      const repos=data.repositories;
      for(const repo of repos) {
        await db.prepare(`INSERT INTO repositories(id,installation_id,name,full_name,html_url,private,enabled)
          VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,full_name=excluded.full_name,html_url=excluded.html_url,private=excluded.private,enabled=1`).run(
          repo.id,inst.id,repo.name,repo.full_name,repo.html_url,repo.private?1:0);
        repoCount++;
      }
      if(repos.length<100)break;
      if(page===5)throw new Error('GitHub repository list exceeded pagination bound');
    }
  }
  // Signed installation webhooks manage app-wide removal. User access is
  // checked afresh for each read and manual request.
  return {linked,repoCount};
}
export async function changedFiles({repoFullName,prNumber,token}) {
  const [owner,repo]=repoFullName.split('/');
  if(!/^[\w.-]+$/.test(owner||'')|| !/^[\w.-]+$/.test(repo||''))throw new Error('Invalid repository');
  const files=[];
  for(let page=1;page<=5;page++) {
    const part=await githubApi(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,token);
    if(!Array.isArray(part))throw new Error('Unexpected GitHub file list response');
    files.push(...part);
    if(part.length<100)return files;
  }
  // A safety guard: don't represent 500/possibly-more files as complete.
  throw new Error('PR has at least 500 changed files; full review coverage unavailable.');
  return files;
}
export async function postReview({repoFullName,prNumber,headSha,token,summary,findings,approval=false}) {
  const [owner,repo]=repoFullName.split('/');
  const comments=findings.slice(0,8).map(f=>({path:f.path,line:f.line,side:'RIGHT',body:`**${f.severity.toUpperCase()} · ${f.title}**\n\n${f.body}\n\n_ReviewForge AI · Confidence: ${Math.round(f.confidence*100)}%_`}));
  if(approval && findings.length)throw new Error('Cannot approve a PR with findings');
  const body={commit_id:headSha,event:approval?'APPROVE':'COMMENT',body:(approval?'<!-- reviewforge-fallback-approval:'+headSha+' -->\n':'')+`## ReviewForge AI review\n\n${summary}\n\n${findings.length} actionable finding(s). AI suggestions may contain mistakes; verify before merging.`,comments};
  try {
    await githubApi(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,token,{method:'POST',body});
    return 'inline';
  } catch(e) {
    // Fallback is safe only for validation failures, not auth/rate-limit/server errors.
    // Other errors must surface to the bounded retry worker.
    if (approval || !String(e.message).startsWith('GitHub 422:')) throw e;
    // A rejected inline review may be caused by an obsolete commit. The
    // generic issue-comment fallback is NOT commit-pinned and would otherwise
    // publish the stale review after the PR moves or closes. Fail closed.
    const current=await githubApi(`/repos/${owner}/${repo}/pulls/${prNumber}`,token);
    if(current.head?.sha!==headSha || current.state!=='open' || current.draft){
      const stale=new Error('Review summary fallback blocked: PR head or state changed.');
      stale.nonRetryable=true;
      throw stale;
    }
    // A 422 can reject valid inline anchors. Never silently omit the actual
    // findings from the non-inline fallback; otherwise the PR displays only
    // a count and the reviewer cannot act on the detected defects.
    const fallbackFindings=findings.slice(0,8).map(f=>{
      const path=String(f.path||'').replace(/[\x60\r\n]/g,'_').slice(0,220);
      const line=Number.isSafeInteger(f.line)?f.line:'?';
      const level=String(f.severity||'').replace(/[^a-z]/gi,'').slice(0,12).toUpperCase();
      const title=String(f.title||'').replace(/[\r\n]/g,' ').slice(0,110);
      const detail=String(f.body||'').slice(0,900).replace(/\r\n?/g,'\n').replace(/\n/g,'\n> ');
      return `- **${level}** \`${path}:${line}\` — ${title}\n> ${detail}`;
    }).join('\n');
    const fallbackBody=body.body+`\n\nInline annotations could not be attached. Please check the ReviewForge dashboard.`+
      (fallbackFindings?`\n\nUnattached findings for reviewed commit \`${headSha}\`:\n${fallbackFindings}`:'');
    await githubApi(`/repos/${owner}/${repo}/issues/${prNumber}/comments`,token,{method:'POST',body:{body:fallbackBody}});
    return 'summary';
  }
}
