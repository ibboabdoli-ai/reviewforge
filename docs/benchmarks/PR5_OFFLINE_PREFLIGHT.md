# Frozen sandbox PR #5: offline preflight handoff

Date: 2026-11-15. This is an **offline mock preflight**, not an AI review or an adjudication of PR #5. No reference answer, CodeRabbit finding, private journal, credential or prompt payload is included here.

## Exact identity and prior work

- Target: [sandbox PR #5](https://github.com/ibboabdoli-ai/reviewforge-sandbox/pull/5), base `420bf122458eb298080bca9e94e6fcfb32339e59`, head `c4054f5e247514c80b76344eb1854e2345aa8037`. The sandbox PR remained draft and unchanged.
- Engine base: [ReviewForge draft PR #22](https://github.com/ibboabdoli-ai/reviewforge/pull/22) at `6460d37e01e176ba727888f1c9864c904dde1106`. The final preflight CI pins the head of the new stacked draft PR and prints that exact engine SHA. It uses the existing `planReviewBatches`, `collectReviewContext`, `reviewWithAI` and `runSingleAttempt` implementations; no review-engine behavior was changed.
- The [earlier PR #5 status](https://github.com/ibboabdoli-ai/reviewforge/blob/6460d37e01e176ba727888f1c9864c904dde1106/benchmarks/HELDOUT_PR5_20261107_STATUS.md) already recorded 8/8 offline coverage on an older engine `e6fd806c53a8aa119af42c373dc363dced071066`. This checkpoint tests the newer PR #22 engine and its journal, request and fail-closed controls. The earlier behavioral witnesses and model attempts were not rerun.

## Frozen source inventory

The changed-file list was computed with `git diff --name-status <base> <head>` in a disposable checkout and compared to this exact eight-path allowlist. Each source file was also inspected at the pinned head. The blob SHAs provide a separate file-identity check.

| Changed path at frozen head | Git blob SHA |
| --- | --- |
| [.github/workflows/holdout-sample.yml](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/.github/workflows/holdout-sample.yml) | `3f1085a034db52e7f29a4298d255957c6e40bcff` |
| [src/lib/invoice-index.mjs](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/src/lib/invoice-index.mjs) | `1d6dac5f710bbd0f1a8c9e239832cf1a5a40b588` |
| [src/lib/tenant-metrics.mjs](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/src/lib/tenant-metrics.mjs) | `bf35211edf859055ab10b37cee9f0acd3ab9a0fa` |
| [src/services/invoice-preview.mjs](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/src/services/invoice-preview.mjs) | `857cc69acaa68bad7d3f8f3ea6ad100056942470` |
| [src/services/seat-reservations.mjs](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/src/services/seat-reservations.mjs) | `b5ebe1d6053d7eecd32b96772e4b7277fbaa0bb9` |
| [tests/invoice-preview.test.mjs](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/tests/invoice-preview.test.mjs) | `5158050e7a309fad234bc7cabf7090b3e37b69a6` |
| [tests/seat-reservations.test.mjs](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/tests/seat-reservations.test.mjs) | `481545abb6f1aac6ba10efac2c317cc14df70656` |
| [tests/tenant-metrics.test.mjs](https://github.com/ibboabdoli-ai/reviewforge-sandbox/blob/c4054f5e247514c80b76344eb1854e2345aa8037/tests/tenant-metrics.test.mjs) | `f2674cd06b0c9957efb1e224dc89a72804689514` |

## Observed offline result

The local disposable checkout at the exact head produced: **8 changed / 8 reviewable / 8 reviewed**, zero missing patches, zero exclusions, zero limited segments, `coverage.complete=true`, one batch containing eight segments, and eight SHA-pinned supplemental reads. The rendered context was 7,311 characters and the serialized synthetic request was 19,603 bytes, below the 12,000-character context and 50,000-byte request limits. The real reviewer parser consumed **one locally constructed synthetic response**. Real OpenAI requests: **0**. GitHub writes by the runner: **0**. No model quality, TP/FP/FN or actual cost is inferred from this mock.

The targeted local test command was `RF_PR5_TARGET=<disposable frozen checkout> node --test tests/pr5-offline-preflight.test.mjs`: **9 passed, 0 failed, 0 skipped**. It covers exact source identity and batch coverage; successful parsing and usage receipt; malformed JSON, HTTP 503 and timeout fail-closed behavior; wrong SHA; 50 KB request gate; filtered suggestion rejection; no-retry after an attempt; synthetic-token redaction; refusal of credential-bearing environment and non-disposable journal paths. The synthetic fetch is injected into the real reviewer, and a test traps global `fetch` to detect an accidental network path. The dedicated [PR #5 offline CI workflow](../../.github/workflows/pr5-offline-preflight.yml) repeats these tests on the final PR commit using only the frozen public sandbox source.

## Blindness, journal and limits

- The harness obtains patches only from the exact sandbox base/head diff. Its supplemental-source adapter permits only the eight listed target files at the exact head. It refuses other paths, including evaluator assets, and checks the constructed request for reference-file markers. No CodeRabbit discussion, pre-registered reference answer or evaluator script is loaded into the reviewer input. Existing evaluator files in the ReviewForge repository are outside this input path.
- Proposed **future** attempt ID: `rf-pr5-audited-once-20261115-v6`. Its separate future journal design is the stable per-OS-account `~/.reviewforge/benchmark-journal/` root with this stem and distinct `.lock`, `.result.json`, `.result.json.dispatch.json`, `.result.json.usage.json` and phase files. The local existence check found all six proposed artifacts absent. This is not a cross-host uniqueness guarantee. This preflight wrote only to disposable `rf-pr5-offline-*` directories under OS temp and removed its own directories; it did not create or modify the future journal or V1–V5 artifacts.
- The runner has **no paid mode**, uses a fixed synthetic request key, rejects real key/approval environment variables, and supplies an in-process mock `requestFetch`. Existing journal code permits exactly one request marker and rejects reuse of a lock or receipt. Failures preserve an unverified report. The CI workflow has read-only GitHub permissions and clears paid-key variables.
- Offline readiness does **not** authorize a paid run. A future paid runner would need its own review of authorization, stable one-use lock, provider budget and secret handling, source blinding and final engine SHA. Any paid call requires a separate explicit decision. PR #16's unresolved threads and broader replacement criteria in [the V4/V5 plan](NEXT_VALIDATION_PLAN.md) still apply.
