// ─────────────────────────────────────────────
// Tests — Server Middleware
// D1 D2 D6 D7 D8 D9 D13
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiKeyAuth } from '../../src/server/middleware/api-key.js';
import { rateLimiter } from '../../src/server/middleware/rate-limiter.js';
import { errorHandler, asyncHandler, notFoundHandler } from '../../src/server/middleware/error-handler.js';
import { SentinelError, ValidationError, NotFoundError, ConflictError, IntegrationError } from '../../src/core/errors.js';

// ── Mock helpers ─────────────────────────────

function makeReq(opts = {}) {
  const headers = opts.headers || {};
  return {
    get: (h) => headers[h.toLowerCase()] ?? null,
    headers,
    ip: opts.ip || '127.0.0.1',
    socket: { remoteAddress: opts.ip || '127.0.0.1' },
    method: opts.method || 'GET',
    path: opts.path || '/',
    ...opts,
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    _headers: {},
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    set(k, v) { this._headers[k] = v; },
  };
  return res;
}

function promiseNext() {
  const state = {};
  const fn = (...args) => { state.called = true; state.args = args; };
  fn.state = state;
  return fn;
}

// ── API Key Middleware (D1 D2 D6 D7 D8) ──────

describe('apiKeyAuth (D1 D6 D7 D8)', () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.SENTINEL_API_KEY; delete process.env.SENTINEL_API_KEY; });
  afterEach(() => { if (savedEnv !== undefined) process.env.SENTINEL_API_KEY = savedEnv; else delete process.env.SENTINEL_API_KEY; });

  // D7: Open mode
  it('passes through (next) when no API key configured', () => {
    const next = promiseNext();
    apiKeyAuth(makeReq(), makeRes(), next);
    assert.equal(next.state.called, true);
    assert.equal(next.state.args.length, 0);
  });

  // D1: Valid key from X-Sentinel-Key header
  it('passes when X-Sentinel-Key matches configured key', () => {
    process.env.SENTINEL_API_KEY = 'super-secret-key-1234';
    const next = promiseNext();
    apiKeyAuth(makeReq({ headers: { 'x-sentinel-key': 'super-secret-key-1234' } }), makeRes(), next);
    assert.equal(next.state.called, true);
    assert.equal(next.state.args.length, 0);
  });

  // D1: Valid key from Authorization: Bearer
  it('passes when Authorization Bearer token matches configured key', () => {
    process.env.SENTINEL_API_KEY = 'super-secret-key-5678';
    const next = promiseNext();
    apiKeyAuth(makeReq({ headers: { 'authorization': 'Bearer super-secret-key-5678' } }), makeRes(), next);
    assert.equal(next.state.called, true);
    assert.equal(next.state.args.length, 0);
  });

  // D6: Missing key when configured — apiKeyAuth throws directly
  it('throws SentinelError (401) when no key provided and key is configured', () => {
    process.env.SENTINEL_API_KEY = 'required-key-abcd';
    assert.throws(
      () => apiKeyAuth(makeReq(), makeRes(), promiseNext()),
      (err) => err instanceof SentinelError && err.statusCode === 401
    );
  });

  // D6: Wrong key
  it('throws SentinelError (401) when wrong key provided', () => {
    process.env.SENTINEL_API_KEY = 'correct-key-00000';
    assert.throws(
      () => apiKeyAuth(makeReq({ headers: { 'x-sentinel-key': 'wrong-key-11111' } }), makeRes(), promiseNext()),
      (err) => err instanceof SentinelError && err.statusCode === 401
    );
  });

  // D8: Multi-key rotation — first key works
  it('accepts any key in comma-separated list (first key)', () => {
    process.env.SENTINEL_API_KEY = 'new-key-aaaaa,old-key-bbbbb';
    const next = promiseNext();
    apiKeyAuth(makeReq({ headers: { 'x-sentinel-key': 'new-key-aaaaa' } }), makeRes(), next);
    assert.equal(next.state.called, true);
    assert.equal(next.state.args.length, 0);
  });

  // D8: Multi-key rotation — second key works
  it('accepts any key in comma-separated list (second key)', () => {
    process.env.SENTINEL_API_KEY = 'new-key-aaaaa,old-key-bbbbb';
    const next = promiseNext();
    apiKeyAuth(makeReq({ headers: { 'x-sentinel-key': 'old-key-bbbbb' } }), makeRes(), next);
    assert.equal(next.state.called, true);
    assert.equal(next.state.args.length, 0);
  });

  // D8: Multi-key rotation — invalid key rejected
  it('throws when key not in multi-key list', () => {
    process.env.SENTINEL_API_KEY = 'new-key-aaaaa,old-key-bbbbb';
    assert.throws(
      () => apiKeyAuth(makeReq({ headers: { 'x-sentinel-key': 'other-key-ccccc' } }), makeRes(), promiseNext()),
      (err) => err instanceof SentinelError && err.statusCode === 401
    );
  });

  // D9: Timing-safe — keys of different lengths are rejected gracefully
  it('rejects mismatched-length key as SentinelError 401', () => {
    process.env.SENTINEL_API_KEY = 'short';
    assert.throws(
      () => apiKeyAuth(makeReq({ headers: { 'x-sentinel-key': 'much-longer-key-that-does-not-match-at-all' } }), makeRes(), promiseNext()),
      (err) => err instanceof SentinelError && err.statusCode === 401
    );
  });
});

// ── Rate Limiter Middleware (D1 D2 D6 D8) ────

describe('rateLimiter (D1 D2 D6 D8)', () => {
  it('passes when under limit (D1)', () => {
    const mw = rateLimiter({ maxRequests: 5, windowMs: 60_000 });
    const next = promiseNext();
    mw(makeReq(), makeRes(), next);
    assert.equal(next.state.called, true);
    assert.equal(next.state.args.length, 0);
  });

  it('sets X-RateLimit headers on passing request (D9)', () => {
    const mw = rateLimiter({ maxRequests: 10, windowMs: 60_000 });
    const res = makeRes();
    mw(makeReq(), res, promiseNext());
    assert.equal(res._headers['X-RateLimit-Limit'], '10');
    assert.ok(Number(res._headers['X-RateLimit-Remaining']) <= 9);
    assert.ok(Number(res._headers['X-RateLimit-Reset']) > 0);
  });

  it('decrements remaining correctly on each call (D2)', () => {
    const mw = rateLimiter({ maxRequests: 3, windowMs: 60_000 });
    const ip = '10.0.0.1';
    mw(makeReq({ ip }), makeRes(), promiseNext());
    mw(makeReq({ ip }), makeRes(), promiseNext());
    const res = makeRes();
    mw(makeReq({ ip }), res, promiseNext());
    assert.equal(res._headers['X-RateLimit-Remaining'], '0');
  });

  it('throws SentinelError (429) when over limit (D6)', () => {
    const mw = rateLimiter({ maxRequests: 2, windowMs: 60_000 });
    const ip = '10.0.0.2';
    mw(makeReq({ ip }), makeRes(), promiseNext());
    mw(makeReq({ ip }), makeRes(), promiseNext());
    assert.throws(
      () => mw(makeReq({ ip }), makeRes(), promiseNext()),
      (err) => err instanceof SentinelError && err.statusCode === 429
    );
  });

  it('sets Retry-After header on rate limit exceeded (D9)', () => {
    const mw = rateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const ip = '10.0.0.3';
    mw(makeReq({ ip }), makeRes(), promiseNext());
    const res = makeRes();
    assert.throws(() => mw(makeReq({ ip }), res, promiseNext()), () => true);
    assert.ok(Number(res._headers['Retry-After']) > 0);
  });

  it('tracks IPs independently (D8)', () => {
    const mw = rateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const next1 = promiseNext();
    const next2 = promiseNext();
    mw(makeReq({ ip: '192.168.1.1' }), makeRes(), next1);
    mw(makeReq({ ip: '192.168.1.2' }), makeRes(), next2);
    // Both should pass (different IPs, each at count=1)
    assert.equal(next1.state.args.length, 0);
    assert.equal(next2.state.args.length, 0);
  });

  it('uses custom keyFn when provided (D8)', () => {
    const mw = rateLimiter({ maxRequests: 1, windowMs: 60_000, keyFn: (req) => req.headers?.['x-user-id'] || 'anon' });
    const userA = makeReq({ headers: { 'x-user-id': 'user-A' } });
    const userB = makeReq({ headers: { 'x-user-id': 'user-B' } });
    mw(userA, makeRes(), promiseNext()); // user-A first request: passes
    assert.throws(() => mw(userA, makeRes(), promiseNext()), () => true); // user-A over limit
    const nextB = promiseNext();
    mw(userB, makeRes(), nextB); // user-B: own counter, passes
    assert.equal(nextB.state.args.length, 0);
  });
});

// ── Error Handler (D1 D6 D7 D8) ──────────────

describe('errorHandler (D1 D6 D7 D8)', () => {
  it('maps ValidationError to 400 with VALIDATION_ERROR code (D1)', () => {
    const err = new ValidationError('invalid input');
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    assert.equal(res._status, 400);
    assert.equal(res._body.error.code, 'VALIDATION_ERROR');
    assert.equal(res._body.error.message, 'invalid input');
    assert.equal(res._body.success, false);
  });

  it('maps NotFoundError to 404 with NOT_FOUND code (D1)', () => {
    const err = new NotFoundError('session not found');
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    assert.equal(res._status, 404);
    assert.equal(res._body.error.code, 'NOT_FOUND');
  });

  it('maps ConflictError to 409 with CONFLICT code (D1)', () => {
    const err = new ConflictError('duplicate session');
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    assert.equal(res._status, 409);
    assert.equal(res._body.error.code, 'CONFLICT');
  });

  it('maps IntegrationError to 502 with INTEGRATION_ERROR code (D1)', () => {
    const err = new IntegrationError('Claude API unavailable');
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    assert.equal(res._status, 502);
    assert.equal(res._body.error.code, 'INTEGRATION_ERROR');
  });

  it('maps raw SentinelError with custom code and status (D1)', () => {
    const err = new SentinelError('auth required', 401, 'AUTH_ERROR');
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    assert.equal(res._status, 401);
    assert.equal(res._body.error.code, 'AUTH_ERROR');
  });

  it('maps entity.parse.failed to 400 PARSE_ERROR (D7)', () => {
    const err = { type: 'entity.parse.failed', status: 400, message: 'Bad JSON' };
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    assert.equal(res._status, 400);
    assert.equal(res._body.error.code, 'PARSE_ERROR');
  });

  it('maps unknown errors to 500 INTERNAL_ERROR (D6)', () => {
    const err = new Error('unexpected crash');
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    assert.equal(res._status, 500);
    assert.equal(res._body.error.code, 'INTERNAL_ERROR');
  });

  it('does not leak error internals for unknown errors (D8 security)', () => {
    const err = new Error('secret db password is abc123');
    const res = makeRes();
    errorHandler(err, makeReq(), res, promiseNext());
    const body = JSON.stringify(res._body);
    assert.ok(!body.includes('abc123'));
  });

  it('does not call next() itself (D9)', () => {
    const err = new ValidationError('test');
    const next = promiseNext();
    errorHandler(err, makeReq(), makeRes(), next);
    assert.equal(next.state.called, undefined); // NOT called
  });
});

// ── notFoundHandler (D6) ─────────────────────

describe('notFoundHandler (D6)', () => {
  it('sends 404 with NOT_FOUND code (D6)', () => {
    const res = makeRes();
    notFoundHandler(makeReq({ path: '/nonexistent' }), res);
    assert.equal(res._status, 404);
    assert.equal(res._body.error.code, 'NOT_FOUND');
  });
});

// ── asyncHandler (D1 D6) ─────────────────────

describe('asyncHandler (D1 D6)', () => {
  it('passes async errors to next() (D6)', async () => {
    const route = asyncHandler(async () => { throw new ValidationError('async fail'); });
    const next = promiseNext();
    await route(makeReq(), makeRes(), next);
    assert.ok(next.state.args[0] instanceof ValidationError);
  });

  it('does not call next on success (D1)', async () => {
    const res = makeRes();
    const route = asyncHandler(async (req, res) => { res.status(200).json({ ok: true }); });
    const next = promiseNext();
    await route(makeReq(), res, next);
    assert.equal(next.state.called, undefined);
    assert.equal(res._status, 200);
  });

  it('forwards SentinelError subclasses (D6)', async () => {
    const route = asyncHandler(async () => { throw new NotFoundError('gone'); });
    const next = promiseNext();
    await route(makeReq(), makeRes(), next);
    assert.ok(next.state.args[0] instanceof NotFoundError);
  });

  it('wraps rejected async function via catch (D7)', async () => {
    const route = asyncHandler(async () => { throw new Error('async throw'); });
    const next = promiseNext();
    await route(makeReq(), makeRes(), next);
    assert.ok(next.state.args[0] instanceof Error);
    assert.equal(next.state.args[0].message, 'async throw');
  });
});
