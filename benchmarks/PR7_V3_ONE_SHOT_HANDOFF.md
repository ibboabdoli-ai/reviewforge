# ReviewForge PR7 V3 — future-only one-shot readiness (no paid call)

This Draft PR is stacked on PR20 and reuses the existing SHA-pinned PR7
preflight, actual ReviewForge reviewer, write-once journal, and mock tests.
**It does not authorize a paid API call.**

- New independent immutable attempt ID: rf-pr7-audited-once-20261111-v3.
- Old V1/V2 locks, reports and ambiguity must stay untouched and **never be retried**.
- Journal files for V3 live beneath the same stable per-OS-user home-based
  benchmark-journal root, but have names unique to V3.
- Fresh future user approval must pin one engine SHA and this precise V3
  attempt ID. Test-key entry is interactive and invisible to the logs.
- V3 PowerShell script is **Preflight by default**; a distinct Paid mode
  requires a new approval ID and exact approved SHA. No hidden auto-start.
- The Python/PowerShell or Node stage reports include only fixed stage names,
  attempt identity and UTC timestamps. No commands, request body, source code,
  raw provider errors or secrets. A hard process kill may leave only earlier
  stages; that is expected and is NOT proof of provider delivery.
- Provider HTTP delivery and invoicing cannot be inferred from pre-fetch
  stages. If the response is incomplete or no receipt exists, result remains
  UNKNOWN; the attempt is never automatically retried.
- One POST maximum, one batch of **15/15 files**, fixed sandbox SHA
  a628945d7533c7418aed344ed5f90a9a2ec8bc46, model gpt-6.1-sol,
  High reasoning, at most 6000 output tokens, <=50000 serialized request
  bytes, experimental 180s timeout. GOLD evidence is never sent to the model.
- Budget planning is $0.20 USD; **not an API-enforced hard monetary cap**.
  Price must be verified before any future authorized paid run.
- All new tests use nonfunctional synthetic credentials on disposable GitHub
  hosted OS user profiles or MOCK PowerShell temporary paths. No live API
  call, merge, production deploy, Proffera or sandbox PR7 edits.

## Validations

- GitHub general CI: Node synthetic success, timeout, network error, crash,
  duplicate-ID racing, failed final-report publication and numeric receipt.
- Hosted Windows: success, Node failure, simulated timeout, caught PowerShell
  exception and forced shell termination (last stage preserved).
- Hosted Ubuntu: exact frozen public PR7 checkout with one fresh offline
  preflight through new V3 code, without provider credentials.

## Real-run gate (NOT NOW)

No one should set the approval environment variables, enter a TEST key or use
Paid mode until fresh explicit user authorization on the exact reviewed SHA,
and owner-only read-only verification of existing attempts and stable paths.
Even then, enforce a single authorized OS user/host. No automatic replay.
