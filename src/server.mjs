import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config,assertConfig,integrations,production } from './config.mjs';
import { openConfiguredDatabase, seedDemo,createSession,getUserBySession, allowedReviews } from './db.mjs';
import { randomToken, cookies,cookie, csrfFor, safeCompare, validOrigin, verifyGithub, sha256 } from './security.mjs';
import { githubOAuthCode, persistUserToken, githubApi, syncInstallations } from './github.mjs';
import { localDemoReview } from './reviewer.mjs';
import { analyzePullRequest } from './pipeline.mjs';
import { checkout,portal,processStripeEvent } from './stripe.mjs';
import * as ui from './ui.mjs';

assertConfig();
const db=await openConfiguredDatabase(config);if(config.demoMode && config.nodeEnv!=='production')await seedDemo(db);
if (!process.env.DATABASE_URL) db.exec("UPDATE jobs SET status='queued' WHERE status='running';");
// Explicit URL-relative static imports keep public assets bundled with Vercel Functions.
const staticFiles = {
  '/styles.css':['text/css; charset=utf-8', readFileSync(new URL('../public/styles.css', import.meta.url))],
  '/app.js':['text/javascript; charset=utf-8', readFileSync(new URL('../public/app.js', import.meta.url))],
  '/favicon.svg':['image/svg+xml', readFileSync(new URL('../public/favicon.svg', import.meta.url))],
};
const reqCounts=new Map();
function limited(req,key,max=20){
  const id=(req.socket.remoteAddress||'local')+key,now=Date.now();let item=reqCounts.get(id);
  if(!item||now-item.start>600000)item={start:now,count:0};item.count++;reqCounts.set(id,item);return item.count>max;
}
const headers={
 'X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin',
 'X-Frame-Options':'DENY','Permissions-Policy':'camera=(), microphone=(), geolocation=()',
 'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
 ...(production?{'Strict-Transport-Security':'max-age=63072000; includeSubDomains'}:{})
};
function send(res,status,body,type='text/html; charset=utf-8',extra={}){
  res.writeHead(status,{...headers,'Content-Type':type,'Cache-Control':'no-store',...extra});res.end(body);
}
function redirect(res,url,extra={}){res.writeHead(303,{...headers,Location:url,'Cache-Control':'no-store',...extra});res.end();}
function fail(res,status,message){send(res,status,`<!doctype html><html lang="en"><meta charset="utf-8"><title>ReviewForge error</title><link rel="stylesheet" href="/styles.css"><body class="error-page"><div class="error-card"><a class="brand" href="/"><span class="brand-mark">◆</span>reviewforge</a><h1>${status}</h1><p>${String(message).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}</p><a href="/dashboard" class="btn btn-primary">Back to dashboard →</a></div></body></html>`);}
async function readBody(req,max=2000000) {
  const chunks=[];let total=0;
  for await (const chunk of req){total+=chunk.length;if(total>max){const err=new Error('Request too large');err.status=413;throw err;}chunks.push(chunk);}
  return Buffer.concat(chunks).toString('utf8');
}
async function ctx(req){const sid=cookies(req).sid;const user=await getUserBySession(db,sid);return {sid,user,demo:user?.github_id===null&&user?.login.startsWith('demo_'),token:user?csrfFor(sid,config.sessionSecret):''};}
function guard(req,res,c,{real=false}={}){
  if(!c.user){redirect(res,'/');return false;}
  if(real&&c.demo){fail(res,403,'Use a real GitHub login to enable this action.');return false;}
  return true;
}
async function formPost(req,c){
  if(!validOrigin(req,config.baseUrl)) {const err=new Error('Invalid request origin');err.status=403;throw err;}
  const raw=await readBody(req,25000),form=new URLSearchParams(raw);
  if(!c.sid||!safeCompare(form.get('csrf'),csrfFor(c.sid,config.sessionSecret))){const err=new Error('Invalid CSRF token');err.status=403;throw err;}
  return form;
}
async function userPage(req,res,c,path,query){
  if(!guard(req,res,c))return true;
  const props={demo:c.demo,notice:query.get('notice')||'',csrfToken:c.token};
  if(path==='/dashboard'){send(res,200,await ui.dashboard(db,c.user,c.token,{demo:c.demo,notice:query.get('notice')||''}));return true;}
  if(path==='/reviews'){send(res,200,await ui.reviewsPage(db,c.user,c.token,props));return true;}
  if(path==='/repositories'){send(res,200,await ui.reposPage(db,c.user,c.token,props));return true;}
  if(path==='/billing'){send(res,200,await ui.billingPage(db,c.user,c.token,{...props,notice:query.get('checkout')==='complete'?'Checkout returned. Subscription becomes active after Stripe webhook confirmation.':query.get('checkout')==='canceled'?'Checkout canceled.':''}));return true;}
  if(path==='/settings'){send(res,200,ui.settingsPage(c.user,c.token,props));return true;}
  const match=path.match(/^\/reviews\/(\d+)$/);if(match){const html=await ui.reviewDetail(db,c.user,c.token,Number(match[1]),props);html?send(res,200,html):fail(res,404,'Review not found.');return true;}
  if(path==='/demo/analyze'){if(!c.demo){fail(res,403,'Demo playground is only available in the demo workspace.');return true;}send(res,200,ui.demoAnalyze(c.user,c.token));return true;}
  return false;
}
async function webhookGithub(req,res){
  if(!config.github.webhookSecret){fail(res,503,'GitHub webhook is not configured');return;}
  const raw=await readBody(req);
  if(!verifyGithub(raw,req.headers['x-hub-signature-256'],config.github.webhookSecret)){send(res,401,'Invalid webhook signature','text/plain');return;}
  const delivery=req.headers['x-github-delivery'];
  if(!delivery||!/^[\w-]{8,100}$/.test(delivery)){send(res,400,'Invalid delivery ID','text/plain');return;}
  const exists=await db.prepare('SELECT id FROM deliveries WHERE id=?').get(delivery);
  if(exists){send(res,200,'Duplicate delivery','text/plain');return;}
  const payload=JSON.parse(raw),event=req.headers['x-github-event'];
  if(event==='pull_request'&&['opened','synchronize','reopened','ready_for_review'].includes(payload.action)){
    const pr=payload.pull_request,repo=payload.repository,inst=payload.installation;
    if(!pr||!repo||!inst){send(res,400,'Incomplete pull request event','text/plain');return;}
    const installed=await db.prepare("SELECT * FROM installations WHERE id=? AND status='active'").get(inst.id);
    if(installed && !pr.draft && integrations().ai){
      // Repository metadata is signed by GitHub. The installation is already bound to a legitimate user.
      await db.prepare(`INSERT INTO repositories(id,installation_id,name,full_name,html_url,private) VALUES(?,?,?,?,?,?)
        ON CONFLICT(id) DO NOTHING`).run(repo.id,inst.id,repo.name,repo.full_name,repo.html_url,repo.private?1:0);
      const rr=await db.prepare('SELECT * FROM repositories WHERE id=? AND installation_id=? AND enabled=1').get(repo.id,inst.id);
      const allowance=await allowedReviews(db,installed.owner_user_id);
      if(rr&&allowance.used<allowance.limit){
        const row=await db.prepare(`INSERT INTO reviews(installation_id,repository_id,pr_number,pr_title,author,head_sha,status)
          VALUES(?,?,?,?,?,?,'queued') ON CONFLICT(repository_id,pr_number,head_sha) DO NOTHING`).run(inst.id,repo.id,pr.number,pr.title?.slice(0,250)||'',pr.user?.login||'',pr.head?.sha||'');
        if(row.changes){
          const r=await db.prepare('SELECT id FROM reviews WHERE repository_id=? AND pr_number=? AND head_sha=?').get(repo.id,pr.number,pr.head.sha);
          await db.prepare('INSERT OR IGNORE INTO jobs(review_id) VALUES(?)').run(r.id);
        }
      }
    }
  }
  if(event==='installation' && payload.action==='deleted'&&payload.installation?.id){
    await db.prepare("UPDATE installations SET status='deleted' WHERE id=?").run(payload.installation.id);
    await db.prepare('UPDATE repositories SET enabled=0 WHERE installation_id=?').run(payload.installation.id);
  }
  if(event==='installation_repositories'&&payload.installation?.id){
    for(const r of payload.repositories_removed||[])await db.prepare('UPDATE repositories SET enabled=0 WHERE id=? AND installation_id=?').run(r.id,payload.installation.id);
    for(const r of payload.repositories_added||[]) {
      const inst=await db.prepare("SELECT id FROM installations WHERE id=? AND status='active'").get(payload.installation.id);
      if(inst)await db.prepare(`INSERT INTO repositories(id,installation_id,name,full_name,html_url,private,enabled) VALUES(?,?,?,?,?,?,1)
        ON CONFLICT(id) DO UPDATE SET enabled=1`).run(r.id,inst.id,r.name,r.full_name,r.html_url||`https://github.com/${r.full_name}`,r.private?1:0);
    }
  }
  await db.prepare('INSERT INTO deliveries(id) VALUES(?)').run(delivery);
  send(res,202,'Accepted','text/plain');
}
let busy=false;
export async function processQueue(){
  if(busy||!integrations().github||!integrations().ai)return;
  const job=db.claimJob
    ? await db.claimJob()
    : await db.prepare(`SELECT j.id job_id,j.attempts,r.*,p.full_name FROM jobs j JOIN reviews r ON r.id=j.review_id
      JOIN repositories p ON p.id=r.repository_id JOIN installations i ON i.id=r.installation_id
      WHERE j.status='queued' AND j.next_attempt_at<=? AND i.status='active' AND p.enabled=1 ORDER BY j.id LIMIT 1`).get(Date.now());
  if(!job)return;busy=true;
  if(!db.claimJob) await db.prepare("UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=?").run(job.job_id);
  await db.prepare("UPDATE reviews SET status='running' WHERE id=?").run(job.id);
  try {
    const result=await analyzePullRequest({
      repository:job.full_name,
      number:job.pr_number,
      headSha:job.head_sha,
      installationId:job.installation_id
    });
    await db.prepare("UPDATE reviews SET status=?,summary=?,findings_json=?,posted=?,error=NULL,finished_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(result.status,result.summary,JSON.stringify(result.findings),result.posted,job.id);
    await db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(job.job_id);
  }catch(err){
    const retries=job.attempts + (db.claimJob?0:1);
    const last=retries>=3;
    await db.prepare('UPDATE jobs SET status=?,next_attempt_at=? WHERE id=?').run(last?'failed':'queued',Date.now()+Math.pow(2,retries)*30000,job.job_id);
    await db.prepare('UPDATE reviews SET status=?,error=?,summary=? WHERE id=?').run(last?'failed':'queued',String(err.message).slice(0,260),'Review failed; check server configuration or GitHub permissions.',job.id);
    console.error('[worker] review',job.id,'failed:',String(err.message).slice(0,180));
  }finally{busy=false;}
}
export async function handler(req,res){
  try{
    const url=new URL(req.url,config.baseUrl),path=url.pathname;
    if(path==='/healthz' && req.method==='GET'){
      await db.prepare('SELECT 1 AS ping').get();
      send(res,200,JSON.stringify({ok:true,version:'0.5.0',database:'ready'}),'application/json');return;
    }
    if(staticFiles[path] && req.method==='GET'){
      res.writeHead(200,{...headers,'Content-Type':staticFiles[path][0],'Cache-Control':'public,max-age=3600'});res.end(staticFiles[path][1]);return;
    }
    const c=await ctx(req);
    if(path==='/internal/process-queue'&&req.method==='POST'){
      const expected=process.env.WORKER_SECRET;
      if (!expected || expected.length<32 || !safeCompare(req.headers.authorization,`Bearer ${expected}`)) {send(res,403,'Forbidden','text/plain');return;}
      await processQueue();send(res,200,'processed','text/plain');return;
    }

    if(path==='/webhooks/github'&&req.method==='POST'){await webhookGithub(req,res);return;}
    if(path==='/webhooks/stripe'&&req.method==='POST'){
      if(!config.stripe.webhookSecret){send(res,503,'Stripe webhook not configured','text/plain');return;}
      const raw=await readBody(req);try{await processStripeEvent(db,raw,req.headers['stripe-signature']);send(res,200,'ok','text/plain');}
      catch(err){send(res,400,'Invalid Stripe event','text/plain');}return;
    }
    if(path==='/'&&req.method==='GET'){c.user?redirect(res,'/dashboard'):send(res,200,ui.home());return;}
    if(path==='/demo'&&req.method==='GET'){
      if(!config.demoMode){fail(res,404,'Demo disabled');return;}
      if(c.user){redirect(res,'/dashboard');return;}
      if(limited(req,'demo',10)){fail(res,429,'Demo session limit reached');return;}
      const handle='demo_'+randomToken(6); const newUser=await db.prepare('INSERT INTO users(login,name) VALUES(?,?) RETURNING id').run(handle,'Demo developer');
      const sid=await createSession(db,Number(newUser.lastInsertRowid));
      redirect(res,'/dashboard',{'Set-Cookie':cookie('sid',sid,{secure:production})});return;
    }
    if(path==='/auth/github'&&req.method==='GET'){
      if(!config.github.clientId||!config.github.clientSecret||config.sessionSecret.length<32){fail(res,503,'GitHub OAuth has not been configured. Try the demo or see README.');return;}
      if(limited(req,'oauth',30)){fail(res,429,'Too many login attempts');return;}
      const state=randomToken(24),callback=config.baseUrl+'/auth/github/callback';
      const target=new URL('https://github.com/login/oauth/authorize');
      target.searchParams.set('client_id',config.github.clientId);target.searchParams.set('redirect_uri',callback);target.searchParams.set('state',state);
      redirect(res,target.toString(),{'Set-Cookie':cookie('oauth_state',state,{secure:production,maxAge:600})});return;
    }
    if(path==='/auth/github/callback'&&req.method==='GET'){
      const state=url.searchParams.get('state'),expected=cookies(req).oauth_state;
      if(!state||!safeCompare(state,expected)||!url.searchParams.get('code')){fail(res,403,'Invalid OAuth state or authorization was declined');return;}
      const tokens=await githubOAuthCode(url.searchParams.get('code'));
      const ghUser=await githubApi('/user',tokens.access_token);
      if(!Number.isSafeInteger(ghUser.id)||!ghUser.login)throw new Error('GitHub profile response incomplete');
      await db.prepare(`INSERT INTO users(github_id,login,name,email) VALUES(?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,name=excluded.name,email=excluded.email`).run(
        ghUser.id,ghUser.login,ghUser.name||ghUser.login,ghUser.email||null);
      const user=await db.prepare('SELECT * FROM users WHERE github_id=?').get(ghUser.id);
      await persistUserToken(db,user.id,tokens);
      const sid=await createSession(db,user.id);
      redirect(res,'/dashboard',{'Set-Cookie':[cookie('sid',sid,{secure:production}),cookie('oauth_state','',{secure:production,maxAge:0})]});return;
    }
    if(path==='/connect/github'&&req.method==='GET'){
      if(!guard(req,res,c,{real:true}))return;
      if(!config.github.appSlug){fail(res,503,'Set GITHUB_APP_SLUG to install your GitHub App.');return;}
      redirect(res,`https://github.com/apps/${encodeURIComponent(config.github.appSlug)}/installations/new`);return;
    }
    if(path==='/github/setup'&&req.method==='GET'){
      if(!guard(req,res,c,{real:true}))return;
      const info=await syncInstallations(db,c.user);
      redirect(res,`/repositories?notice=${encodeURIComponent(`Synced ${info.linked} installations, ${info.repoCount} repositories`)}`);return;
    }
    if(req.method==='GET'&&await userPage(req,res,c,path,url.searchParams))return;
    if(req.method==='POST'&&path==='/logout'){
      if(!guard(req,res,c))return;await formPost(req,c);
      await db.prepare('DELETE FROM sessions WHERE token_hash=?').run(sha256(c.sid));
      redirect(res,'/',{'Set-Cookie':cookie('sid','',{secure:production,maxAge:0})});return;
    }
    if(req.method==='POST'&&path==='/settings/sync'){
      if(!guard(req,res,c,{real:true}))return;await formPost(req,c);
      if(limited(req,'sync',12)){fail(res,429,'Sync rate limit reached');return;}
      const info=await syncInstallations(db,c.user);
      redirect(res,`/dashboard?notice=${encodeURIComponent(`Synced ${info.linked} installation(s) and ${info.repoCount} repository(s).`)}`);return;
    }
    if(req.method==='POST'&&path==='/demo/analyze'){
      if(!guard(req,res,c))return;if(!c.demo){fail(res,403,'Demo only');return;}
      const form=await formPost(req,c);if(limited(req,'analyze',25)){fail(res,429,'Analysis rate limit reached');return;}
      const diff=String(form.get('diff')||'').slice(0,16000),title=String(form.get('title')||'Demo review').slice(0,120);
      if(!diff.trim()){fail(res,400,'Please paste a diff');return;}
      const result=localDemoReview(diff);
      const r=await db.prepare(`INSERT INTO reviews(demo_user_id,pr_number,pr_title,author,head_sha,status,summary,findings_json,finished_at)
       VALUES(?,?,?,?,?,'completed',?,?,CURRENT_TIMESTAMP) RETURNING id`).run(c.user.id,Math.floor(Date.now()/1000)%100000,title,c.user.login,randomToken(6),result.summary,JSON.stringify(result.findings));
      redirect(res,`/reviews/${r.lastInsertRowid}`);return;
    }
    if(req.method==='POST'&&path==='/billing/checkout'){
      if(!guard(req,res,c,{real:true}))return;await formPost(req,c);
      if(!integrations().billing){fail(res,503,'Stripe not configured');return;}
      if(limited(req,'checkout',10)){fail(res,429,'Checkout limit reached');return;}
      const current=await db.prepare('SELECT stripe_customer_id,status FROM subscriptions WHERE user_id=?').get(c.user.id);
      if(current?.stripe_customer_id){fail(res,409,'A billing customer already exists. Use Manage subscription.');return;}
      const session=await checkout(c.user);redirect(res,session.url);return;
    }
    if(req.method==='POST'&&path==='/billing/portal'){
      if(!guard(req,res,c,{real:true}))return;await formPost(req,c);
      const row=await db.prepare('SELECT stripe_customer_id FROM subscriptions WHERE user_id=?').get(c.user.id);
      if(!row?.stripe_customer_id||!config.stripe.secret){fail(res,400,'No Stripe customer to manage');return;}
      const session=await portal(row.stripe_customer_id);redirect(res,session.url);return;
    }
    fail(res,404,'Page not found');
  }catch(err){console.error('[request]',String(err.message).slice(0,200));
    fail(res,err.status||500,err.status?err.message:'Unexpected server error. Check server logs.');}
}
if (!process.env.VERCEL && process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1])) {
const server=createServer(handler);
server.listen(config.port,()=>console.log(`[ReviewForge] ${config.baseUrl} · demo=${config.demoMode} · posting=${config.reviewPostMode} · integrations=${JSON.stringify(integrations())}`));
const tick=setInterval(()=>processQueue().catch(err=>console.error('[worker]',err.message)),3500);tick.unref();
const cleanup=setInterval(async()=>{await db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
 await db.prepare("DELETE FROM deliveries WHERE received_at<datetime('now','-30 days')").run();},3600000);cleanup.unref();
process.on('SIGINT',()=>{server.close();db.close();process.exit(0);});
process.on('SIGTERM',()=>{server.close();db.close();process.exit(0);});
}
