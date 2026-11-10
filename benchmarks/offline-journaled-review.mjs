import { Buffer } from 'node:buffer';
import { planReviewBatches, reviewWithAI } from '../src/reviewer.mjs';
import { runSingleAttempt } from './one-shot-journal.mjs';

// Fixed public sandbox fixture. No gold evidence or answer key is loaded.
// This adapter is *offline-only* until a separately authorized paid runner
// has its own reviewed budget/secret handling and legacy attempt protection.
export const FROZEN_PR7 = Object.freeze({
  repository: 'ibboabdoli-ai/reviewforge-sandbox',
  pr: 7,
  headSha: 'a628945d7533c7418aed344ed5f90a9a2ec8bc46',
  model: 'gpt-6.1-sol'
});
const EXPECTED_PATHS = Object.freeze([
  '.github/workflows/heldout-lock-check.yml', 'package.json',
  'src/lib/booking-repository.mjs', 'src/lib/mock-transaction-pool.mjs',
  'src/lib/notice-format.mjs', 'src/lib/notification-lock.mjs',
  'src/lib/workspace-capabilities.mjs', 'src/services/booking-notice.mjs',
  'src/services/deposit-reminder.mjs', 'src/services/deposit-updates.mjs',
  'tests/booking-notice.test.mjs', 'tests/deposit-reminder.test.mjs',
  'tests/notice-lifecycle.integration.test.mjs',
  'tests/notification-lock.test.mjs', 'tests/workspace-format.test.mjs'
]);
const EXPECTED = new Set(EXPECTED_PATHS);
const IMPORTANT = [
  'src/lib/notification-lock.mjs',
  'src/services/booking-notice.mjs',
  'src/services/deposit-reminder.mjs',
  'src/services/deposit-updates.mjs'
];

export function verifyFrozenBatch({files,reviewContext,metadata}) {
  if(metadata?.repository!==FROZEN_PR7.repository ||
      metadata?.pr!==FROZEN_PR7.pr ||
      metadata?.headSha!==FROZEN_PR7.headSha ||
      metadata?.model!==FROZEN_PR7.model ||
      !/^[a-f0-9]{40}$/i.test(metadata?.engineSha??'')) {
    throw new Error('FROZEN_PR7_IDENTITY_MISMATCH');
  }
  if(!Array.isArray(files) || files.length!==EXPECTED.size ||
      new Set(files.map(f=>f?.filename)).size!==EXPECTED.size ||
      files.some(f=>!EXPECTED.has(f?.filename))) {
    throw new Error('FROZEN_PR7_CHANGED_FILE_SET_MISMATCH');
  }
  const selected = planReviewBatches(files,{maxBatches:1,maxBatchCharacters:24000});
  if(!selected.coverage.complete || selected.coverage.reviewed!==EXPECTED.size ||
      selected.coverage.reviewable!==EXPECTED.size || selected.batches.length!==1 ||
      selected.coverage.unanchoredDeletions || selected.coverage.limited ||
      selected.batches[0].some(f=>!EXPECTED.has(f.filename)) ||
      IMPORTANT.some(path=>!selected.batches[0].some(f=>f.filename===path))) {
    throw new Error('FROZEN_PR7_COVERAGE_INCOMPLETE');
  }
  if(reviewContext?.headSha!==FROZEN_PR7.headSha ||
      !Number.isSafeInteger(reviewContext.totalChars) ||
      reviewContext.totalChars<0 || reviewContext.totalChars>12000 ||
      !Array.isArray(reviewContext.snippets) ||
      !reviewContext.snippets.some(s=>s.path==='src/lib/notification-lock.mjs' &&
        typeof s.text==='string' && s.text.length>0) ||
      reviewContext.snippets.some(s=>/gold|answer.?key/i.test(s.path??''))) {
    throw new Error('FROZEN_PR7_CONTEXT_MISSING_OR_UNTRUSTED');
  }
  return selected.batches[0];
}

/**
 * Connect actual ReviewForge reviewWithAI to the durable one-shot journal using
 * an injected *synthetic* HTTP response. No live API key or fetch is accepted.
 * This tests the real validation/timeout/error/receipt path, NOT AI recall.
 */
export async function runOfflineJournaledReview({
  files,reviewContext,metadata,lockPath,reportPath,mockFetch
}) {
  if(typeof mockFetch!=='function' || mockFetch===globalThis.fetch ||
      process.env.OPENAI_API_KEY || process.env.OPENAI_TEST_API_KEY) {
    throw new Error('OFFLINE_ONLY_NO_REAL_KEY_OR_FETCH');
  }
  const batch=verifyFrozenBatch({files,reviewContext,metadata});
  return runSingleAttempt({
    lockPath,reportPath,metadata,
    execute:async({markModelRequestStart,recordProviderUsage})=>{
      const result=await reviewWithAI(batch,{
        model:FROZEN_PR7.model,reasoningEffort:'high',reviewContext,
        requestKey:'sk-LOCAL-SYNTHETIC-NOT-A-CREDENTIAL',requestFetch:mockFetch,
        onBeforeRequest:({model,store,reasoningEffort,maxOutputTokens,requestBytes})=>{
          if(model!==FROZEN_PR7.model || store!==false ||
              reasoningEffort!=='high' || maxOutputTokens!==6000 ||
              !Number.isSafeInteger(requestBytes) || requestBytes>50000) {
            throw new Error('OFFLINE_REQUEST_CAP_FAILED');
          }
          markModelRequestStart();
        },
        onProviderReceipt:recordProviderUsage
      });
      if(result.diagnostics?.filteredFindings!==0) {
        throw new Error('UNVERIFIED_MODEL_SUGGESTIONS');
      }
      return result;
    }
  });
}
