import { existsSync, readFileSync, writeFileSync, linkSync, rmSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, dirname } from 'node:path';

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

// Node on Windows does not support fsync-ing a directory handle (EPERM).
// On POSIX fsync the parent directory as well as the file. On Windows,
// FlushFileBuffers on the file is performed via flush:true below; power-loss
// durability of directory metadata cannot be guaranteed by portable Node.
function syncParentDirectory(path) {
  if (process.platform === 'win32') return false;
  const fd = openSync(dirname(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

function atomicCreate(path, payload) {
  const temp = path + '.partial-' + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(payload, null, 2), { flag: 'wx', mode: 0o600, flush: true });
    // linkSync creates the destination atomically and fails on EEXIST.
    // renameSync could silently replace an existing report on POSIX.
    linkSync(temp, path);
    syncParentDirectory(path);
    // A hard link does NOT move its source. Remove the sensitive temporary
    // name after publication; the canonical destination still owns the data.
    rmSync(temp, { force: true });
    syncParentDirectory(path);
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

function cleanDiagnostics(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const natural = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return {
    modelSuggestions: natural(raw.modelSuggestions),
    acceptedFindings: natural(raw.acceptedFindings),
    filteredFindings: natural(raw.filteredFindings)
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
  // A narrow receipt may survive a process crash after HTTP 200 but before
  // the final model result could be validated. Match the same immutable
  // repository/PR/head/engine/model identity before exposing token evidence.
  let receipt = null;
  if (existsSync(reportPath + '.usage.json')) {
    try {
      const saved = JSON.parse(readFileSync(reportPath + '.usage.json', 'utf8'));
      if (saved.repository === lock.repository && saved.pr === lock.pr &&
          saved.headSha === lock.headSha && saved.engineSha === lock.engineSha &&
          saved.model === lock.model) {
        receipt = sanitizeUsage(saved.providerUsage);
      }
    } catch {
      // Corrupt or mismatched receipts must never become billing evidence.
    }
  }
  // Old 2026-11-09 one-shot lock is understood but must never be replayed.
  return {
    status: 'orphaned_unverified',
    modelAttemptCount: receipt ? 1 : null,
    providerUsage: receipt,
    startedAt: lock.startedAt || null,
    reason: 'A started attempt has no persisted model verdict; do not retry'
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
  }), { flag: 'wx', mode: 0o600, flush: true });
  // Best-effort host-crash durable before any model work. The POSIX parent
  // directory is fsynced; Windows has file flushing but no portable dir fsync.
  syncParentDirectory(lockPath);

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
        typeof result.summary !== 'string' || !Array.isArray(result.findings) ||
        (providerUsage?.httpStatus != null &&
         (providerUsage.httpStatus < 200 || providerUsage.httpStatus >= 300))) {
      throw new Error('INVALID_COMPLETED_REVIEW');
    }
    const report = { ...base(), status: 'completed',
      summary: redact(result.summary).slice(0, 600),
      findings: result.findings.slice(0, 8).map(cleanFinding).filter(Boolean),
      diagnostics: cleanDiagnostics(result.diagnostics),
      note: 'Result received, but independent gold scoring has not run'
    };
    atomicCreate(reportPath, report);
    return report;
  } catch (error) {
    const status = failureKind(error);
    // No raw provider error, request body or API key is saved. A competing
    // attempt must never overwrite the report that already won publication.
    let reportAvailable = existsSync(reportPath);
    if (!reportAvailable) {
      try {
        atomicCreate(reportPath, { ...base(), status,
          errorCode: status, findings: null,
          providerOutcome: modelAttemptCount ? 'unknown_after_attempt' : 'not_started',
          note: 'No trustworthy model verdict. Do not replay this paid attempt.'
        });
        reportAvailable = true;
      } catch {
        // Disk error or concurrent no-clobber: preserve the original lock.
      }
    }
    const safe = new Error(reportAvailable
      ? 'REVIEW_NOT_COMPLETED: inspect existing report; do not retry'
      : 'REVIEW_NOT_COMPLETED: inspect attempt lock; report unavailable; do not retry');
    safe.code = status;
    throw safe;
  }
}