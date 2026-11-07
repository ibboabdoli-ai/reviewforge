# Held-out equipment rental fixture

This synthetic fixture is independent of the Maria benchmark and uses no customer data, credentials, or paid services. `candidate/` is the only permissible future reviewer input. `gold.json` and `verify.mjs` are sealed evaluator material and must never be sent to the reviewer model.

Run `node benchmarks/heldout-equipment-20261107/verify.mjs` to reproduce the three registered defects and check the negative controls. This deterministic check establishes the reference behavior; it does not measure model detection. A model evaluation needs separate owner approval and a bounded cost. Keep its reviewer input frozen before that evaluation.
