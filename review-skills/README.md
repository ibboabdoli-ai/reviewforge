# Built-in review skills (loaded by ReviewForge)

These are **version-controlled review instructions**, not third-party executables
or unverified skills installed from the internet. Runtime source:
`src/review-skills.mjs`.

ReviewForge loads the general safety policy on **every AI request**, then selects
matching specialist rules from:

- Authorization / tenant isolation
- Billing, Stripe and subscription lifecycle
- Database integrity and migrations
- Web application security
- Jobs, retries and concurrency
- Frontend behavior and async state
- Tests and regression coverage
- CI and supply-chain security

This is a review-focus layer, **not evidence of detecting bugs**. Reviewer output
still needs exact changed-line anchors, test confirmation and comparison with
CodeRabbit on real PRs. We do not execute untrusted external skill packages
during a review.
