# ReviewForge: three-PR historical quality audit (2026-10-31)

## Scope and limits

This is a **retrospective, offline** analysis of three already completed ReviewForge shadow reviews in `ibboabdoli-ai/Proffera`. ReviewForge has not re-reviewed any PR, paid for a model request, posted comments or changed Proffera. Each historical run used different model capabilities or prompt/context rules. **Do not treat these ratios as blind-test accuracy or claim a comparison proves one reviewer is superior.**

| PR (immutable HEAD) | Historical ReviewForge run | Verified/scoped reference cases | Matched accepted findings | Missed cases |
| --- | --- | ---: | ---: | ---: |
| #953 (`b00783f`) | #4, `gpt-6-luna`, earlier reviewer | 3 | 0 | 3 |
| #949 (`412e7e3`) | #5, `gpt-6.1-sol`, before dual-lens audit | 6 | 1 | 5 |
| #944 (`9cd94db`) | #6, `gpt-6.1-sol`, with dual-lens audit | 2 | 2 | 0 |
| **Historical total** | Three selected runs | **11** | **3** | **8** |

The 3 accepted findings from the archived runs matched one of the 11 scoped reference cases each; this is **not a general false-positive-rate estimate**. Gold references for #944 were triaged after seeing ReviewForge findings, which creates **selection bias**. The #949 and #953 model runs happened before the latest dual-lens improvements and must not be called failures of the current version.

## PR #949 evidence triage

CodeRabbit posted six comments about possible missing test coverage. Independent source inspection supported five clear testing blind spots:

1. The browser-storage privacy E2E test checks final storage, not transient secret-bearing writes.
2. A repeated session key returned from the **same** sessionStorage is not proof of independent random keys in fresh sessions.
3. The missing-crypto test calls the helper, not the component's no-event `sendEvent` guard.
4. A stubbed SQL result does not exercise the real rate-limit `ON CONFLICT` update.
5. Direct link-helper tests do not check whether the actual dashboard renders safe actions for stored bookings.

The sixth CodeRabbit comment suggested additional focused draft-restore unit tests. Some restore behavior is already covered by E2E, so this suggestion is retained as **unscored advisory**, not proven defective behavior. A separate Codex comment described a plausible second-locale-switch race; it remains **unscored pending isolated reproduction**.

ReviewForge's only reported #949 finding concerns valid email local-parts with an apostrophe being rejected by the new regex. The code path is inspectable and this case is counted. Thus the #949 historical score is **1/6**, not 1/7 or 1/8. The five test gaps are backed by source inspection; their business impact and actual test execution have not been proven in Proffera.

## PR #944 evidence triage

The two accepted issues from shadow run #6 are plausible and supported by source:
- An invalid-company assertion can pass on a missing second HTTP mock, without reaching the intended company validation.
- The credential-redaction assertion checks `HTTP 429` but never checks the configured API key is absent.

The old CodeRabbit `aeTyp=3` issue was **fixed at the current #944 SHA**; do not count it as a current defect.

## How to reproduce the offline suite

```sh
npm test
node benchmarks/score-suite.mjs
node benchmarks/score-review.mjs --pr 949
node benchmarks/score-review.mjs --pr 944
node benchmarks/score-review.mjs --pr 953
```

- `benchmarks/observed-reviewforge.json` contains only sanitized, frozen historical accepted findings and model identity, not user or business credentials.
- `benchmarks/proffera-pr{944,949,953}-gold.json` are reference data, never imported by the actual reviewer.
- `score-suite.mjs` checks matching SHA, review identity and shadow posting state before calculating per-PR stats. Never silently average the result into a claim of current model quality.
- `tests/pr949-synthetic-mutation-demonstrations.test.mjs` illustrates five blind spots in local synthetic functions; `tests/pr944-mutation-demonstrations.test.mjs` does the same for two #944 cases. They **do not execute or modify Proffera**, connect to a database or invoke OpenAI.

## Next validation before more investment

For a real **unseen** quality evaluation, pre-register expected behaviors on a separate isolated, synthetic PR **before** sending it to ReviewForge. Cap model calls, keep posting dry-run, and independently judge each reported finding against the same immutable HEAD, reporting both misses and false alarms. Do not replay completed PRs on identical commits to manufacture a before/after improvement. Continue treating CodeRabbit as the primary check until a larger blinded sample supports substitution.
