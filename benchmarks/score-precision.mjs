import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scoreReviewQuality } from './score-review.mjs';

export const reference = JSON.parse(readFileSync(
  new URL('./sandbox-precision-20261102-gold.json', import.meta.url), 'utf8'));

export function scorePrecisionReview(record) {
  if (!record || record.repository !== reference.targetRepository ||
      record.pr_number !== reference.targetPr ||
      record.head_sha !== reference.targetHeadSha ||
      record.status !== 'completed' || Number(record.posted) !== 0 ||
      !Array.isArray(record.findings)) {
    throw new Error('Review is not the completed, no-post, exact-SHA registered sample');
  }
  const result = scoreReviewQuality({cases:reference.primaryCases}, record.findings);
  const cleanPaths = new Set(reference.cleanControls.map(x => x.path));
  const controlCandidates = record.findings.filter(f => cleanPaths.has(f.path));
  return {
    benchmark: reference.benchmarkId,
    primaryCount: result.referenceCount,
    primaryMatched: result.detected,
    primaryMissed: result.missed,
    acceptedFindings: record.findings.length,
    unscoredFindings: result.unmatchedFindings,
    cleanControlCandidateCount: controlCandidates.length,
    cleanControlCandidates: controlCandidates.map(f => ({
      path: f.path, line: f.line, title: String(f.title || '').slice(0, 180)
    })),
    interpretation: 'Manual review required. Unmatched findings and clean-control comments are not automatically false positives; one constructed PR cannot establish general accuracy.'
  };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3) {
    console.error('Usage: node benchmarks/score-precision.mjs <sanitized-review-record.json>');
    process.exitCode = 2;
  } else {
    const record = JSON.parse(readFileSync(process.argv[2], 'utf8'));
    console.log(JSON.stringify(scorePrecisionReview(record), null, 2));
  }
}
