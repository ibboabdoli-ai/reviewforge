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


test('risk-named but unrelated tests cannot crowd out every test tied to changed source',()=>{
  const sources=entries(['src/components/widget-grid.tsx']);
  const tests=entries([
    'tests/auth-login.test.ts',
    'tests/security-audit.test.ts',
    'tests/token-refresh.test.ts',
    'tests/widget-grid.test.ts'
  ]);
  const selected=prioritizeBehaviorTests(tests,sources).slice(0,3).map(f=>f.filename);
  assert.ok(selected.includes('tests/widget-grid.test.ts'),
    'At least one source-linked regression must survive the three-test context budget');
  assert.equal(selected.length,3,'Do not increase the context or model budget');
});

test('unrelated security-named tests cannot displace a second changed-source regression',()=>{
  const sources=entries(['src/components/widget-grid.tsx','src/lib/price-planner.ts']);
  const tests=entries([
    'tests/auth-login.test.ts',
    'tests/security-audit.test.ts',
    'tests/token-refresh.test.ts',
    'tests/widget-grid.test.ts',
    'tests/price-planner.test.ts'
  ]);
  const selected=prioritizeBehaviorTests(tests,sources).slice(0,3).map(f=>f.filename);
  assert.ok(selected.includes('tests/widget-grid.test.ts'),
    'Keep a regression linked to the first changed runtime path');
  assert.ok(selected.includes('tests/price-planner.test.ts'),
    'Keep a regression linked to the second changed runtime path');
  assert.equal(selected.length,3,'The AI test-context budget must remain unchanged');
});

test('generic shared features/ segment must not mislabel unrelated security tests as source-linked',()=>{
  // Isolated regression: old matcher marked all three unrelated security
  // tests as source-linked through the generic directory token 'features'.
  // That prevented the two-slot rescue for actual changed-source regressions.
  const sources=entries([
    'src/features/booking/availability.ts',
    'src/features/pricing/annual-rates.ts'
  ]);
  const tests=entries([
    'src/features/auth/login-security.test.ts',
    'src/features/privacy/audit-security.test.ts',
    'src/features/token/session-token.test.ts',
    'src/features/booking/availability.test.ts',
    'src/features/pricing/annual-rates.test.ts'
  ]);
  const selected=prioritizeBehaviorTests(tests,sources).slice(0,3).map(f=>f.filename);
  assert.equal(selected.length,3,'Preserve fixed context and model budget');
  assert.ok(selected.includes('src/features/booking/availability.test.ts'),
    'Reserve changed-booking regression rather than generic-folder security test');
  assert.ok(selected.includes('src/features/pricing/annual-rates.test.ts'),
    'Reserve changed-pricing regression rather than generic-folder security test');
});
