/**
 * A fixed, version-controlled two-lens inspection method. These are trusted
 * review instructions; PR content and repository rules remain untrusted.
 * This never requests the model to execute code or to speculate.
 */
export const BEHAVIOR_TEST_REVIEW_METHOD=[
  'BEHAVIOR AND TEST AUDIT: Perform two distinct internal inspections within this same single model request. Do not add an extra model call.',
  'LENS A -- runtime correctness: for changed functions, identify inputs, state transitions, callers and downstream effects shown in the diff or provided context. Form at least one concrete counterexample (such as wrong entity identity, empty input, stale state, duplicate request or failed upstream dependency). Report only if the supplied evidence proves an introduced or exposed functional defect.',
  'LENS B -- test effectiveness: for each changed test, identify the exact changed production contract it is supposed to protect. Imagine a minimal plausible mutation in the implementation: replace a random output with a constant, reverse a guard, drop a database update, or return a success-shaped mocked value. Determine whether the actual test assertions would fail. If the test still passes despite an important broken contract, identify the concrete missing assertion and impact. Anchoring must use a real newly added line in the test patch.',
  'Separate a demonstrated runtime bug from a demonstrated test-coverage gap. Do not confuse mere missing tests with a verified regression. Do not assume a test ran or that an unshown caller behaves a certain way.',
  'When the relevant source, actual assertions or call site is absent, refrain from alleging a bug. Make no GitHub writes, code execution or external calls.',
  'For each reported issue include the triggering situation, precise evidence in supplied code, and a narrowly scoped, testable fix. Maintain the existing severity, line anchoring and confidence requirements.'
].join(' ');
