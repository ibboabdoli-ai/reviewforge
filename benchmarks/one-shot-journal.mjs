import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

/**
 * Local, single-attempt journal for a controlled paid benchmark.
 * Never imports credentials, performs network I/O, or retries a request.
 * The caller must mark the outbound model attempt immediately before fetch.
 */
function safeMetadata(value) {
  if (!value || typeof value !== 'object') throw new TypeError('Metadata is required');
  if (!/^[0-9a-f]{40}$/i.test(value.headSha) ||
      !/^[0-9a-f]{40}$/i.test(value.engineSha) ||
      !/^[\w.-]+\/[\w.-]+$/.test(value.repository) ||
      !Number.isSafeInteger(value.pr) || value.pr < 1 ||
      typeof value.model !== 'string' || value.model.length > 80) {
    throw new TypeError('Invalid immutable benchmark identity');
  }
  return { repository: value.repository, pr: value.pr,
    headSha: value.headSha, engineSha: value.engineSha, model: value.model };
}

function atomicCreate(path, payload) {
  const temp = path + '.partial-' + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600 });
    if (existsSync(path)) throw new Error('Journal target already exists');
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

function sanitizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const natural = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const status = Number.isSafeInteger(raw.httpStatus) &&
    raw.httpStatus >= 100 && raw.httpStatus <= 599 ? raw.httpStatus : null;
  const requestId = typeof raw.requestId === 'string' &&
    /^[a-zA-Z0-9_-]{5,110}$/.test(raw.requestId) ? raw.requestId : null;
  return {
    httpStatus: status, inputTokens: natural(raw.inputTokens),
    outputTokens: natural(raw.outputTokens), requestId
  };
}

// Remove common credential shapes from any private model text we retain.
function redact(value) {
  return String(value ?? '').replace(
    /sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/g,
    '[REDACTED_TOKEN]'
  );
}
function cleanFinding(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    path: redact(f.path).slice(0, 240),
    line: Number.isSafeInteger(f.line) && f.line > 0 ? f.line : null,
    severity: redact(f.severity).slice(0, 20),
    category: redact(f.category).slice(0, 50),
    title: redact(f.title).slice(0, 140),
    body: redact(f.body).slice(0, 1200),
    confidence: Number.isFinite(f.confidence) ? f.confidence : null
  };
}

function failureKind(error) {
  const name = typeof error?.name === 'string' ? error.name : '';
  if (name === 'TimeoutError') return 'timeout_unverified';
  if (name === 'AbortError') return 'aborted_unverified';
  if (name === 'SyntaxError') return 'invalid_response_unverified';
  return 'error_unverified';
}

/** Inspect a journal without contacting a provider or attempting a retry. */
export function inspectAttempt({ lockPath, reportPath }) {
  if (!isAbsolute(lockPath) || !isAbsolute(reportPath))
    throw new TypeError('Absolute journal paths required');
  if (existsSync(reportPath)) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    return {
      status: report.status, modelAttemptCount: report.modelAttemptCount,
      providerUsage: report.providerUsage || null,
      hasFindings: report.status === 'completed' && Array.isArray(report.findings),
      completedAt: report.completedAt || null
    };
  }
  if (!existsSync(lockPath)) return { status: 'not_started', modelAttemptCount: 0 };
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  // Old 2026-11-09 one-shot lock is understood but must never be replayed.
  return {
    status: 'orphaned_unverified', modelAttemptCount: null,
    startedAt: lock.startedAt || null,
    reason: 'A started attempt has no persisted response; do not retry'
  };
}

/**
 * No API calls happen here. An injected execute callback is responsible for
 * the single provider call and must call markModelRequestStart immediately
 * before its only fetch. A known failure writes an unverified diagnostic and
 * throws a generic, credential-safe error.
 */
export async function runSingleAttempt({ lockPath, reportPath, metadata, execute }) {
  if (typeof execute !== 'function' || !isAbsolute(lockPath) ||
      !isAbsolute(reportPath) || lockPath === reportPath) {
    throw new TypeError('Safe absolute journal paths and execute callback required');
  }
  const identity = safeMetadata(metadata);
  if (existsSync(lockPath) || existsSync(reportPath))
    throw new Error('PREVIOUS_ATTEMPT_EXISTS: no automatic replay allowed');
  const startedAt = new Date().toISOString(), startedMs = Date.now();
  writeFileSync(lockPath, JSON.stringify({
    ...identity, status: 'started_unverified', startedAt, maximumAttempts: 1,
    providerOutcome: 'unknown', costUsd: null
  }), { flag: 'wx', mode: 0o600 });

  let modelAttemptCount = 0, providerUsage = null;
  const markModelRequestStart = () => {
    if (modelAttemptCount !== 0)
      throw new Error('ONE_MODEL_REQUEST_ONLY');
    modelAttemptCount = 1;
  };
  const recordProviderUsage = info => {
    if (modelAttemptCount !== 1 || providerUsage !== null)
      throw new Error('PROVIDER_RECEIPT_MUST_FOLLOW_EXACTLY_ONE_CALL');
    providerUsage = sanitizeUsage(info);
    // Preserve a narrow receipt even if a later response validation fails.
    atomicCreate(reportPath + '.usage.json', {
      ...identity, recordedAt: new Date().toISOString(), providerUsage
    });
  };

  const base = () => ({
    ...identity, startedAt, completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedMs, modelAttemptCount,
    providerUsage, costUsd: null, githubWrites: 0,
    independentQualityMeasured: false
  });
  try {
    const result = await execute({ markModelRequestStart, recordProviderUsage });
    if (modelAttemptCount !== 1 || !result ||
        typeof result.summary !== 'string' || !Array.isArray(result.findings)) {
      throw new Error('INVALID_COMPLETED_REVIEW');
    }
    const report = { ...base(), status: 'completed',
      summary: redact(result.summary).slice(0, 600),
      findings: result.findings.slice(0, 8).map(cleanFinding).filter(Boolean),
      diagnostics: result.diagnostics || null,
      note: 'Result received, but independent gold scoring has not run'
    };
    atomicCreate(reportPath, report);
    return report;
  } catch (error) {
    const status = failureKind(error);
    // No raw provider error text, request body or API key is saved.
    atomicCreate(reportPath, { ...base(), status,
      errorCode: status, findings: null,
      providerOutcome: modelAttemptCount ? 'unknown_after_attempt' : 'not_started',
      note: 'No trustworthy model verdict. Do not replay this paid attempt.'
    });
    const safe = new Error('REVIEW_NOT_COMPLETED: diagnostic saved; do not retry');
    safe.code = status;
    throw safe;
  }
}