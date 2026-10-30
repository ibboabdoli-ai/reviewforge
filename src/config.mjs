import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { allowedRepositories, dailyRequestLimit } from './review-policy.mjs';
try { process.loadEnvFile?.(resolve(process.cwd(), '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
export const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.APP_URL || (process.env.VERCEL ? `https://${process.env.VERCEL_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || ''}` : 'http://localhost:3000')).replace(/\/$/, ''),
  dbPath: resolve(process.env.DB_PATH || './data/reviewforge.sqlite'),
  sessionSecret: process.env.SESSION_SECRET || (process.env.NODE_ENV==='production'?'':randomBytes(32).toString('hex')),
  demoMode: process.env.NODE_ENV !== 'production' && process.env.DEMO_MODE !== 'false',
  reviewPostMode: process.env.REVIEW_POST_MODE || 'dry-run',
  aiReviewEnabled: process.env.AI_REVIEW_ENABLED === 'true',
  aiAllowedRepositories: allowedRepositories(process.env.AI_ALLOWED_REPOSITORIES),
  aiShadowRepositories: allowedRepositories(process.env.AI_SHADOW_REPOSITORIES),
  aiUnlimitedRepositories: allowedRepositories(process.env.AI_UNLIMITED_REPOSITORIES),
  aiAutoModelRepositories: allowedRepositories(process.env.AI_AUTO_MODEL_REPOSITORIES),
  aiFallbackOnlyRepositories: allowedRepositories(process.env.AI_FALLBACK_ONLY_REPOSITORIES),
  aiFallbackApprovalRepositories: allowedRepositories(process.env.AI_FALLBACK_APPROVAL_REPOSITORIES),
  aiDailyRequestLimit: dailyRequestLimit(process.env.AI_DAILY_REQUEST_LIMIT ?? '1'),
  nodeEnv: process.env.NODE_ENV || 'development',
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    appId: process.env.GITHUB_APP_ID || '',
    appSlug: process.env.GITHUB_APP_SLUG || '',
    privateKey: (process.env.GITHUB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || ''
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    modelFast: process.env.OPENAI_MODEL_FAST || 'gpt-6-luna',
    modelDeep: process.env.OPENAI_MODEL_DEEP || 'gpt-6.1-sol'
  },
  stripe: {
    secret: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    pricePro: process.env.STRIPE_PRICE_PRO || ''
  }
};
export const production = config.nodeEnv === 'production';
export function assertConfig() {
  if (production && !process.env.DATABASE_URL) throw new Error('Production requires DATABASE_URL');
  if (!['dry-run','live'].includes(config.reviewPostMode)) throw new Error('REVIEW_POST_MODE must be dry-run or live');
  if (production && (config.sessionSecret.length < 32 || config.sessionSecret.includes('replace-with') || !/^https:\/\/[^/]+\.[^/]+$/.test(config.baseUrl))) {
    throw new Error('Production requires SESSION_SECRET >=32 characters and HTTPS APP_URL');
  }
  if (!production && !process.env.SESSION_SECRET) console.warn('[setup] Using an ephemeral development SESSION_SECRET; sessions reset on restart.');
}
export function integrations() {
  return {
    github: !!(config.github.clientId && config.github.clientSecret && config.github.appId && config.github.privateKey && config.github.webhookSecret && config.sessionSecret.length >= 32),
    ai: config.aiReviewEnabled && !!config.openai.apiKey,
    billing: !!(config.stripe.secret && config.stripe.webhookSecret && config.stripe.pricePro)
  };
}
