import { config } from '../src/config.mjs';

// Configuration-only diagnostics. No remote calls and no credentials logged.
const checks=[
  ['Node.js >=22.13', ()=> {const [major,minor]=process.versions.node.split('.').map(Number);return major>22||(major===22&&minor>=13);}],
  ['Neon PostgreSQL DATABASE_URL for production',()=>!!process.env.DATABASE_URL && /^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL)],
  ['Worker secret for guarded queue endpoint',()=>!!process.env.WORKER_SECRET && process.env.WORKER_SECRET.length>=32],
  ['HTTPS APP_URL (required for public GitHub webhooks)',()=>config.baseUrl.startsWith('https://')],
  ['Persistent SESSION_SECRET (>=32 chars)',()=>!!process.env.SESSION_SECRET && config.sessionSecret.length>=32 && !config.sessionSecret.includes('replace-with')],
  ['GitHub App ID',()=>!!config.github.appId],
  ['GitHub App slug',()=>!!config.github.appSlug],
  ['GitHub client ID',()=>!!config.github.clientId],
  ['GitHub client secret',()=>!!config.github.clientSecret],
  ['GitHub App private RSA key',()=>config.github.privateKey.startsWith('-----BEGIN ') && config.github.privateKey.includes('PRIVATE KEY-----')],
  ['GitHub webhook secret',()=>config.github.webhookSecret.length>=20],
  ['OpenAI API key',()=>!!config.openai.apiKey],
  ['Safe review mode configured',()=>['dry-run','live'].includes(config.reviewPostMode)]
];
let missing=0;
console.log('ReviewForge — GitHub + AI setup checks (configuration only)\n');
for (const [label,test] of checks){const ok=test();console.log(`${ok?'[OK]  ':'[TODO]'} ${label}`);if(!ok)missing++;}
console.log(`\nMode: ${config.reviewPostMode==='live'?'LIVE — reviews will be posted to GitHub':'DRY RUN — model results stay in the dashboard'}`);
console.log(`\nRequired callback URLs:\n  ${config.baseUrl}/auth/github/callback\n  ${config.baseUrl}/github/setup\n  ${config.baseUrl}/webhooks/github`);
console.log(`\n${missing?`${missing} setup item(s) still missing. No network calls were made.`:'All configuration checks passed. Live API connectivity has NOT been verified.'}`);
if(missing)process.exitCode=1;
