import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomToken, sha256 } from './security.mjs';

export function openDatabase(file) {
  mkdirSync(dirname(file),{recursive:true});
  const db=new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id INTEGER UNIQUE,
      login TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      email TEXT,
      token_cipher TEXT,
      refresh_cipher TEXT,
      token_expires_at INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS installations (
      id INTEGER PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id),
      account_login TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE TABLE IF NOT EXISTS repositories (
      id INTEGER PRIMARY KEY,
      installation_id INTEGER NOT NULL REFERENCES installations(id),
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      html_url TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      repository_id INTEGER REFERENCES repositories(id),
      demo_user_id INTEGER REFERENCES users(id),
      pr_number INTEGER,
      pr_title TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      head_sha TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      summary TEXT NOT NULL DEFAULT '',
      findings_json TEXT NOT NULL DEFAULT '[]',
      posted INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      UNIQUE(repository_id,pr_number,head_sha)
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      received_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_id INTEGER NOT NULL UNIQUE REFERENCES reviews(id),
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY,received_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      stripe_customer_id TEXT UNIQUE,
      stripe_subscription_id TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'free',
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_installation ON reviews(installation_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_jobs_ready ON jobs(status,next_attempt_at);
  `);
  return db;
}
export async function createSession(db,userId) {
  const token=randomToken(); const expires=Date.now()+14*86400000;
  await db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha256(token),userId,expires);
  return token;
}
export async function getUserBySession(db, token) {
  if (!token) return null;
  return await db.prepare(`SELECT users.*,sessions.token_hash FROM sessions JOIN users ON users.id=sessions.user_id
   WHERE sessions.token_hash=? AND sessions.expires_at>?`).get(sha256(token),Date.now())||null;
}
export async function activePlan(db,userId) {
  const subscription = await db.prepare('SELECT status FROM subscriptions WHERE user_id=?').get(userId);
  const s=subscription?.status;
  return s==='active'||s==='trialing'?'pro':'free';
}
export async function usedReviews(db,userId) {
  const count=await db.prepare(`SELECT COUNT(*) AS total FROM reviews r
    JOIN installations i ON i.id=r.installation_id
    WHERE i.owner_user_id=? AND r.created_at >= datetime('now','start of month') `).get(userId);
  return Number(count?.total||0);
}
export async function allowedReviews(db,userId){
  const plan=await activePlan(db,userId); return {plan,limit:plan==='pro'?500:10,used:await usedReviews(db,userId)};
}
export async function seedDemo(db) {
  await db.prepare("INSERT OR IGNORE INTO users(id,github_id,login,name) VALUES (-1,-1,'demo','Demo Workspace')").run();
  const count=await db.prepare('SELECT COUNT(*) AS c FROM reviews WHERE demo_user_id=-1').get();
  const c=Number(count.c);
  if(!c) {
    const s=await db.prepare(`INSERT INTO reviews(demo_user_id,pr_number,pr_title,author,head_sha,status,summary,findings_json,finished_at)
      VALUES(-1,?,?,?,?, 'completed',?,?,CURRENT_TIMESTAMP)`);
    await s.run(142,'Fix checkout idempotency','alexdev','demo001',
      'Detected a possible duplicate payment flow and a missing validation guard.',
      JSON.stringify([{path:'src/payments/checkout.ts',line:49,severity:'critical',category:'correctness',title:'Missing idempotency guard',body:'Repeated requests may create duplicate checkout sessions.',confidence:0.95},{path:'src/api/orders.ts',line:21,severity:'medium',category:'security',title:'Validate customer ownership',body:'Verify that the order belongs to the authenticated customer before mutation.',confidence:0.89}]));
    await s.run(138,'Improve session handling','sarah','demo002','Review completed. One important security issue identified.',JSON.stringify([{path:'src/auth/session.ts',line:87,severity:'high',category:'security',title:'Session cookie missing secure flag',body:'Enable Secure cookies in production to prevent transport downgrade.',confidence:0.94}]));
    await s.run(131,'Refactor dashboard metrics','marco','demo003','No actionable issues found.',JSON.stringify([]));
  }
}

export async function openConfiguredDatabase(config) {
  if (process.env.DATABASE_URL) {
    const { openPostgres } = await import('./db-postgres.mjs');
    return openPostgres(process.env.DATABASE_URL);
  }
  if (config.nodeEnv==='production') throw new Error('DATABASE_URL is required in production');
  return openDatabase(config.dbPath);
}
