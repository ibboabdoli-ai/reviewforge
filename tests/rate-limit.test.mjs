import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimiter, clientKey } from '../src/rate-limit.mjs';

test('Vercel req with a null socket does not crash sync rate limiting', () => {
  const old = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    const req = { socket: null, headers: { 'x-vercel-forwarded-for': '192.0.2.10' } };
    const limited = createLimiter();
    assert.equal(clientKey(req), '192.0.2.10');
    assert.equal(limited(req, 'sync', 2), false);
    assert.equal(limited(req, 'sync', 2), false);
    assert.equal(limited(req, 'sync', 2), true);
    assert.equal(limited(req, 'oauth', 2), false);
  } finally {
    if (old === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = old;
  }
});

test('no socket or header falls back safely; rate-limit window resets', () => {
  const old = process.env.VERCEL;
  delete process.env.VERCEL;
  try {
    let time = 100;
    const limited = createLimiter({now: () => time});
    const req = { socket: null, headers: {} };
    assert.equal(clientKey(req), 'unknown');
    assert.equal(limited(req, 'sync', 1), false);
    assert.equal(limited(req, 'sync', 1), true);
    time += 600001;
    assert.equal(limited(req, 'sync', 1), false);
  } finally {
    if (old !== undefined) process.env.VERCEL = old;
  }
});

test('local node requests use socket remoteAddress, not untrusted forwarded header', () => {
  const old = process.env.VERCEL;
  delete process.env.VERCEL;
  try {
    assert.equal(clientKey({socket: {remoteAddress:'127.0.0.1'}, headers:{'x-vercel-forwarded-for':'203.0.113.12'}}), '127.0.0.1');
  } finally {
    if (old !== undefined) process.env.VERCEL = old;
  }
});
