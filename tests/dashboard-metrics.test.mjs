import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboard } from '../src/ui.mjs';

test('dashboard waits for PostgreSQL count rows before rendering metrics', async () => {
  // PostgreSQL COUNT(*) is a bigint, returned as a string by node-postgres.
  // All database methods resolve asynchronously, unlike the SQLite adapter.
  const db = {
    prepare(sql) {
      return {
        async all() { return []; },
        async get() {
          if (sql.includes('COUNT(*) n FROM repositories')) return { n: '2' };
          if (sql.includes('COUNT(*) n FROM reviews')) return { n: '5' };
          if (sql.includes('COUNT(*) AS total FROM reviews')) return { total: '1' };
          if (sql.includes('SELECT status FROM subscriptions')) return undefined;
          throw new Error('Unexpected query: ' + sql);
        }
      };
    }
  };
  const html = await dashboard(db, { id: 42, login: 'test-user', name: 'Test User' }, 'test-csrf');
  assert.ok(html.includes('<div class="stat-value">5</div>'));
  assert.ok(html.includes('<div class="stat-value">2</div>'));
  assert.ok(html.includes('0 <span>/ 10 reviews</span>'));
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('dashboard shows zero when PostgreSQL count rows are missing', async () => {
  const db = {
    prepare(sql) {
      return {
        async all() { return []; },
        async get() {
          if (sql.includes('SELECT status FROM subscriptions')) return undefined;
          if (sql.includes('COUNT(*) AS total FROM reviews')) return { total: 0 };
          if (sql.includes('COUNT(*) n FROM ')) return undefined;
          throw new Error('Unexpected query: ' + sql);
        }
      };
    }
  };
  const html = await dashboard(db, { id: 43, login: 'new-user' }, 'test-csrf');
  assert.ok(html.includes('<div class="stat-value">0</div>'));
  assert.doesNotMatch(html, /undefined|NaN/);
});
