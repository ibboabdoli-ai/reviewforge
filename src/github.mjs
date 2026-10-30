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
export async function installationsForUser(db,user) {
  const token=await githubUserToken(db,user);
  const result=[];
  for(let page=1;page<=5;page++) {
    const data=await githubApi(`/user/installations?per_page=100&page=${page}`,token);
    result.push(...(data.installations||[]));
    if((data.installations||[]).length<100)break;
  }
  return {token,installations:result};
}
export async function syncInstallations(db,user) {
  const {token,installations}=await installationsForUser(db,user);
  let linked=0,repoCount=0;
  for(const inst of installations) {
    const accessibleIds=[];
    const current=await db.prepare('SELECT owner_user_id FROM installations WHERE id=?').get(inst.id);
    if(current && current.owner_user_id!==user.id)continue;
    await db.prepare(`INSERT INTO installations(id,owner_user_id,account_login,status) VALUES(?,?,?,'active')
      ON CONFLICT(id) DO UPDATE SET account_login=excluded.account_login,status='active'`).run(inst.id,user.id,inst.account?.login||'unknown');
    linked++;
    // Only show repositories the signed-in user can actually access.
    for(let page=1;page<=5;page++) {
      const data=await githubApi(`/user/installations/${inst.id}/repositories?per_page=100&page=${page}`,token);
      const repos=data.repositories||[];
      for(const repo of repos) {
        await db.prepare(`INSERT INTO repositories(id,installation_id,name,full_name,html_url,private,enabled)
          VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET
          name=excluded.name,full_name=excluded.full_name,html_url=excluded.html_url,private=excluded.private`).run(
          repo.id,inst.id,repo.name,repo.full_name,repo.html_url,repo.private?1:0);
        accessibleIds.push(repo.id);
        repoCount++;
      }
      if(repos.length<100)break;
    }
    if(accessibleIds.length){
      const placeholders=accessibleIds.map(()=>'?').join(',');
      await db.prepare(`UPDATE repositories SET enabled=0 WHERE installation_id=? AND id NOT IN (${placeholders})`).run(inst.id,...accessibleIds);
      await db.prepare(`UPDATE repositories SET enabled=1 WHERE installation_id=? AND id IN (${placeholders})`).run(inst.id,...accessibleIds);
    } else await db.prepare('UPDATE repositories SET enabled=0 WHERE installation_id=?').run(inst.id);
  }
  // Revoked access is not allowed to retain active review entitlement.
  if(installations.length<500){
    const ids=installations.map(i=>i.id);
    if(ids.length)await db.prepare(`UPDATE installations SET status='disconnected' WHERE owner_user_id=? AND id NOT IN (${ids.map(()=>'?').join(',')})`).run(user.id,...ids);
    else await db.prepare(`UPDATE installations SET status='disconnected' WHERE owner_user_id=?`).run(user.id);
  }
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
export async function postReview({repoFullName,prNumber,headSha,token,summary,findings}) {
  const [owner,repo]=repoFullName.split('/');
  const comments=findings.slice(0,8).map(f=>({path:f.path,line:f.line,side:'RIGHT',body:`**${f.severity.toUpperCase()} · ${f.title}**\n\n${f.body}\n\n_ReviewForge AI · Confidence: ${Math.round(f.confidence*100)}%_`}));
  const body={commit_id:headSha,event:'COMMENT',body:`## ReviewForge AI review\n\n${summary}\n\n${findings.length} actionable finding(s). AI suggestions may contain mistakes; verify before merging.`,comments};
  try {
    await githubApi(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,token,{method:'POST',body});
    return 'inline';
  } catch(e) {
    // Fallback is safe only for validation failures, not auth/rate-limit/server errors.
    // Other errors must surface to the bounded retry worker.
    if (!String(e.message).startsWith('GitHub 422:')) throw e;
    await githubApi(`/repos/${owner}/${repo}/issues/${prNumber}/comments`,token,{method:'POST',body:{body:body.body+`\n\nInline annotations could not be attached. Please check the ReviewForge dashboard.`}});
    return 'summary';
  }
}
