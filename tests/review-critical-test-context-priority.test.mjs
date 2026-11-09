import test from 'node:test';
import assert from 'node:assert/strict';
import { prioritizeBehaviorTests } from '../src/review-context.mjs';

// Synthetic analogue of Proffera #949 / 412e7e32, without reading any
// live repository or invoking an AI model. Only changed-path identities matter.
const sourceNames=[
  'src/components/public-business/public-business-tracking.tsx',
  'src/components/salon/salon-dashboard-demo.tsx',
  'src/features/quote-request/localized-quote-request-form.tsx'
];
const testNames=[
  'e2e/tests/public-critical-flows.e2e.mjs',
  'tests/marketplace-funnel-analytics.test.ts',
  'tests/public-business-session-key.test.ts',
  'tests/public-form-protection-fingerprint-continuity.test.ts',
  'tests/quote-request-language-switch-guard.test.ts',
  'tests/salon-demo-contact-links.test.ts'
];
const entries=names=>names.map(filename=>({filename}));

test('three SHA-pinned test-context slots retain high-impact negative-path tests',()=>{
  const ranked=prioritizeBehaviorTests(entries(testNames),entries(sourceNames))
    .slice(0,3).map(file=>file.filename);
  assert.equal(ranked.length,3,'Existing bounded three-test context budget is unchanged');
  assert.deepEqual(ranked,[
    'tests/quote-request-language-switch-guard.test.ts',
    'tests/public-business-session-key.test.ts',
    'tests/public-form-protection-fingerprint-continuity.test.ts'
  ],'Both security-sensitive session-key and rate-limit fixtures must survive priority selection');
});

test('ordinary tests without security-significant names keep source-overlap and stable ties',()=>{
  const sources=entries(['src/components/widget-grid.tsx','src/lib/price-planner.ts']);
  const tests=entries(['tests/unrelated.test.ts','tests/widget-grid.test.ts','tests/price-planner.test.ts']);
  assert.deepEqual(
    prioritizeBehaviorTests(tests,sources).map(file=>file.filename),
    ['tests/widget-grid.test.ts','tests/price-planner.test.ts','tests/unrelated.test.ts']
  );
});
