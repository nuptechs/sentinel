// ─────────────────────────────────────────────
// Tests — DebugProbeTraceAdapter
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DebugProbeTraceAdapter } from '../../src/adapters/trace/debugprobe.adapter.js';

describe('DebugProbeTraceAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new DebugProbeTraceAdapter({ maxTraces: 100 });
  });

  it('isConfigured returns true', () => {
    assert.equal(adapter.isConfigured(), true);
  });

  it('getTraces returns empty for unknown session', async () => {
    const traces = await adapter.getTraces('unknown');
    assert.deepEqual(traces, []);
  });

  it('getTraceByCorrelation returns null for unknown', async () => {
    const trace = await adapter.getTraceByCorrelation('unknown');
    assert.equal(trace, null);
  });

  it('fetches remote traces from the Debug Probe API when baseUrl is configured', async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      async json() {
        return {
          events: [
            {
              id: 'evt-1',
              sessionId: 'sess-remote',
              source: 'sdk',
              type: 'http-request',
              timestamp: 1_000,
              correlationId: 'corr-remote',
              data: { method: 'GET', path: '/api/test', url: '/api/test' },
            },
            {
              id: 'evt-2',
              sessionId: 'sess-remote',
              source: 'sdk',
              type: 'db-query',
              timestamp: 1_005,
              correlationId: 'corr-remote',
              data: { query: 'SELECT 1', durationMs: 4 },
            },
            {
              id: 'evt-3',
              sessionId: 'sess-remote',
              source: 'sdk',
              type: 'http-response',
              timestamp: 1_010,
              correlationId: 'corr-remote',
              data: { statusCode: 200, durationMs: 10 },
            },
          ],
          total: 3,
        };
      },
    });

    try {
      const remoteAdapter = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'test-key',
        maxTraces: 100,
      });

      const traces = await remoteAdapter.getTraces('sess-remote');
      assert.equal(traces.length, 1);
      assert.equal(traces[0].correlationId, 'corr-remote');
      assert.equal(traces[0].payload.method, 'GET');
      assert.equal(traces[0].payload.statusCode, 200);
      assert.equal(traces[0].payload.queryCount, 1);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('normalizes native Debug Probe event shapes (top-level fields + network/sdk types)', async () => {
    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        async json() {
          return {
            events: [
              // network source → type 'request', method/url at top level
              {
                id: 'e1', sessionId: 's', source: 'network', type: 'request',
                timestamp: 100, correlationId: 'c1',
                method: 'POST', url: '/api/users', path: '/api/users',
              },
              // sdk source → type 'request-end' acts as http-response
              {
                id: 'e2', sessionId: 's', source: 'sdk', type: 'request-end',
                timestamp: 110, correlationId: 'c1',
                statusCode: 201, durationMs: 42,
              },
              // db-query at top level
              {
                id: 'e3', sessionId: 's', source: 'sdk', type: 'db-query',
                timestamp: 105, correlationId: 'c1',
                query: 'INSERT INTO users...', durationMs: 5, rowCount: 1,
              },
            ],
            total: 3,
          };
        },
      };
    };

    try {
      const adapterRemote = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'k',
      });
      const traces = await adapterRemote.getTraces('s');
      assert.equal(traces.length, 1);
      assert.equal(traces[0].payload.method, 'POST');
      assert.equal(traces[0].payload.path, '/api/users');
      assert.equal(traces[0].payload.statusCode, 201);
      assert.equal(traces[0].payload.durationMs, 42);
      assert.equal(traces[0].payload.queryCount, 1);
      assert.equal(traces[0].payload.queries[0].sql, 'INSERT INTO users...');

      // Auth header: X-API-Key must be present
      assert.equal(calls[0].init.headers['X-API-Key'], 'k');
    } finally {
      global.fetch = originalFetch;
    }
  });

  describe('ensureRemoteSession', () => {
    it('POSTs /api/sessions with X-API-Key and returns remoteSessionId', async () => {
      const originalFetch = global.fetch;
      const captured = [];
      global.fetch = async (url, init) => {
        captured.push({ url, init });
        return {
          ok: true,
          async json() { return { id: 'probe-sess-123', name: 'sentinel-abc' }; },
        };
      };

      try {
        const adapterRemote = new DebugProbeTraceAdapter({
          baseUrl: 'http://probe.local',
          apiKey: 'api-k',
        });
        const res = await adapterRemote.ensureRemoteSession({
          id: 'abc', projectId: 'proj-1', metadata: { source: 'qa' },
        });

        assert.equal(res.ok, true);
        assert.equal(res.remoteSessionId, 'probe-sess-123');
        assert.equal(captured.length, 1);
        assert.match(captured[0].url, /\/api\/sessions$/);
        assert.equal(captured[0].init.method, 'POST');
        assert.equal(captured[0].init.headers['X-API-Key'], 'api-k');
        const body = JSON.parse(captured[0].init.body);
        assert.equal(body.name, 'sentinel-abc');
        assert.ok(body.tags.includes('sentinel:project:proj-1'));
        assert.ok(body.tags.includes('sentinel:session:abc'));
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('returns {ok:false} (non-throwing) when remote call fails', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => ({ ok: false, status: 500, async json() { return {}; } });
      try {
        const adapterRemote = new DebugProbeTraceAdapter({
          baseUrl: 'http://probe.local',
          apiKey: 'k',
        });
        const res = await adapterRemote.ensureRemoteSession({ id: 's', projectId: 'p' });
        assert.equal(res.ok, false);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('returns {ok:false} when baseUrl not configured', async () => {
      const res = await adapter.ensureRemoteSession({ id: 's' });
      assert.equal(res.ok, false);
    });
  });

  describe('_forwardToRemote (Gap 6)', () => {
    it('POSTs translated events to /api/sessions/<remoteId>/events after ensureRemoteSession', async () => {
      const originalFetch = global.fetch;
      const captured = [];
      global.fetch = async (url, init) => {
        captured.push({ url, init });
        return {
          ok: true,
          async json() {
            return /\/api\/sessions$/.test(url) ? { id: 'remote-XYZ' } : { ingested: 3 };
          },
        };
      };

      try {
        const a = new DebugProbeTraceAdapter({
          baseUrl: 'http://probe.local',
          apiKey: 'k',
        });
        await a.ensureRemoteSession({ id: 'sent-1', projectId: 'p1' });

        a._store({
          correlationId: 'c-1',
          sessionId: 'sent-1',
          createdAt: 1000,
          request: { method: 'POST', path: '/api/x', url: '/api/x?y=1', ip: '1.2.3.4' },
          response: { statusCode: 201, durationMs: 42 },
          queries: [
            { sql: 'SELECT 1', durationMs: 2, rowCount: 1, error: null },
            { sql: 'INSERT ...', durationMs: 5, rowCount: 1, error: null },
          ],
        });

        // Wait for fire-and-forget to settle
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        const forward = captured.find((c) => /\/api\/sessions\/remote-XYZ\/events$/.test(c.url));
        assert.ok(forward, 'expected forward POST to occur');
        assert.equal(forward.init.method, 'POST');
        assert.equal(forward.init.headers['X-API-Key'], 'k');

        const body = JSON.parse(forward.init.body);
        assert.equal(body.events.length, 4); // 1 req + 1 res + 2 queries
        assert.equal(body.events[0].type, 'request-start');
        assert.equal(body.events[0].method, 'POST');
        assert.equal(body.events[0].sessionId, 'remote-XYZ');
        assert.equal(body.events[1].type, 'request-end');
        assert.equal(body.events[1].statusCode, 201);
        assert.equal(body.events[2].type, 'db-query');
        assert.equal(body.events[2].query, 'SELECT 1');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('does not forward when ensureRemoteSession was never called', async () => {
      const originalFetch = global.fetch;
      const captured = [];
      global.fetch = async (url, init) => {
        captured.push({ url, init });
        return { ok: true, async json() { return {}; } };
      };

      try {
        const a = new DebugProbeTraceAdapter({
          baseUrl: 'http://probe.local',
          apiKey: 'k',
        });

        a._store({
          correlationId: 'c-2',
          sessionId: 'unknown-sent',
          createdAt: 1000,
          request: { method: 'GET', path: '/x', url: '/x' },
          response: { statusCode: 200, durationMs: 1 },
          queries: [],
        });

        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.equal(captured.length, 0, 'no remote calls expected without session mapping');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('swallows forward errors and never crashes _store', async () => {
      const originalFetch = global.fetch;
      let calls = 0;
      global.fetch = async (url) => {
        calls++;
        if (/\/api\/sessions$/.test(url)) {
          return { ok: true, async json() { return { id: 'rid' }; } };
        }
        return { ok: false, status: 500, async json() { return {}; } };
      };

      try {
        const a = new DebugProbeTraceAdapter({
          baseUrl: 'http://probe.local',
          apiKey: 'k',
        });
        await a.ensureRemoteSession({ id: 'sx', projectId: 'p' });

        // Must not throw even though forward will 500
        a._store({
          correlationId: 'c-3',
          sessionId: 'sx',
          createdAt: 1,
          request: { method: 'GET', path: '/', url: '/' },
          response: { statusCode: 200, durationMs: 1 },
          queries: [],
        });

        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.ok(calls >= 2, 'forward POST attempted');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('middleware', () => {
    function mockReq({ sessionId, correlationId, method = 'GET', path = '/test', body = null } = {}) {
      const headers = {};
      if (sessionId) headers['x-sentinel-session'] = sessionId;
      if (correlationId) headers['x-sentinel-correlation'] = correlationId;
      return {
        method,
        path,
        originalUrl: path,
        ip: '127.0.0.1',
        query: {},
        body,
        headers,
        get: (name) => headers[name.toLowerCase()],
      };
    }

    function mockRes() {
      const res = {
        statusCode: 200,
        _headers: {},
        getHeaders: () => res._headers,
        setHeader: (k, v) => { res._headers[k] = v; },
        end: () => {},
      };
      return res;
    }

    it('captures HTTP request/response', async () => {
      const middleware = adapter.createMiddleware();
      const req = mockReq({ sessionId: 'sess-1', correlationId: 'corr-1' });
      const res = mockRes();

      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });
      assert.ok(nextCalled);

      // Simulate response finish
      res.statusCode = 201;
      res.end();

      const traces = await adapter.getTraces('sess-1');
      assert.equal(traces.length, 1);
      assert.equal(traces[0].correlationId, 'corr-1');
      assert.equal(traces[0].payload.method, 'GET');
      assert.equal(traces[0].payload.path, '/test');
      assert.equal(traces[0].payload.statusCode, 201);
    });

    it('skips capture without session header', async () => {
      const middleware = adapter.createMiddleware();
      const req = mockReq({ sessionId: null });
      const res = mockRes();

      let nextCalled = false;
      middleware(req, res, () => { nextCalled = true; });
      assert.ok(nextCalled);
      res.end();

      assert.equal(adapter.size, 0);
    });

    it('generates correlationId if not provided', async () => {
      const middleware = adapter.createMiddleware();
      // No X-Request-Id, no X-Sentinel-Correlation; but has session
      const req = {
        method: 'POST', path: '/api/test', originalUrl: '/api/test',
        ip: '127.0.0.1', query: {}, body: { x: 1 },
        headers: { 'x-sentinel-session': 'sess-2' },
        get: (name) => req.headers[name.toLowerCase()],
      };
      const res = mockRes();

      middleware(req, res, () => {});
      res.end();

      const traces = await adapter.getTraces('sess-2');
      assert.equal(traces.length, 1);
      assert.ok(traces[0].correlationId); // auto-generated UUID
    });

    it('sanitizes sensitive headers', async () => {
      const middleware = adapter.createMiddleware();
      const req = mockReq({ sessionId: 's' });
      req.headers.authorization = 'Bearer secret';
      req.headers.cookie = 'session=abc';
      const res = mockRes();

      middleware(req, res, () => {});
      res.end();

      const trace = await adapter.getTraces('s');
      const reqHeaders = trace[0].payload; // formatted trace
      // The raw entry should not contain authorization
      const entry = adapter.traces.values().next().value;
      assert.equal(entry.request.headers.authorization, undefined);
      assert.equal(entry.request.headers.cookie, undefined);
    });

    // Gap 7 — correlation header alias chain + response propagation
    it('accepts X-Probe-Correlation-Id as correlation alias', async () => {
      const middleware = adapter.createMiddleware();
      const req = {
        method: 'GET', path: '/probe', originalUrl: '/probe',
        ip: '127.0.0.1', query: {}, body: null,
        headers: {
          'x-sentinel-session': 'sess-probe',
          'x-probe-correlation-id': 'probe-corr-1',
        },
        get: (name) => req.headers[name.toLowerCase()],
      };
      const res = mockRes();
      middleware(req, res, () => {});
      res.end();

      const traces = await adapter.getTraces('sess-probe');
      assert.equal(traces.length, 1);
      assert.equal(traces[0].correlationId, 'probe-corr-1');
    });

    it('accepts X-Request-Id as correlation alias', async () => {
      const middleware = adapter.createMiddleware();
      const req = {
        method: 'GET', path: '/rid', originalUrl: '/rid',
        ip: '127.0.0.1', query: {}, body: null,
        headers: {
          'x-sentinel-session': 'sess-rid',
          'x-request-id': 'rid-42',
        },
        get: (name) => req.headers[name.toLowerCase()],
      };
      const res = mockRes();
      middleware(req, res, () => {});
      res.end();

      const traces = await adapter.getTraces('sess-rid');
      assert.equal(traces[0].correlationId, 'rid-42');
    });

    it('emits correlation headers on response', async () => {
      const middleware = adapter.createMiddleware();
      const req = mockReq({ sessionId: 'sess-resp', correlationId: 'corr-resp' });
      const res = mockRes();
      middleware(req, res, () => {});
      res.end();

      assert.equal(res._headers['X-Sentinel-Correlation'], 'corr-resp');
      assert.equal(res._headers['X-Probe-Correlation-Id'], 'corr-resp');
    });
  });

  describe('LRU eviction', () => {
    it('evicts oldest trace when maxTraces exceeded', async () => {
      const adapter2 = new DebugProbeTraceAdapter({ maxTraces: 3 });
      const middleware = adapter2.createMiddleware();

      for (let i = 1; i <= 4; i++) {
        const req = {
          method: 'GET', path: `/test/${i}`, originalUrl: `/test/${i}`,
          ip: '127.0.0.1', query: {}, body: null,
          headers: {
            'x-sentinel-session': `s${i}`,
            'x-sentinel-correlation': `c${i}`,
          },
          get: (name) => req.headers[name.toLowerCase()],
        };
        const res = { statusCode: 200, _headers: {}, getHeaders: () => ({}), setHeader: () => {}, end: () => {} };
        middleware(req, res, () => {});
        res.end();
      }

      assert.equal(adapter2.size, 3);
      // First entry should be evicted
      const evicted = await adapter2.getTraceByCorrelation('c1');
      assert.equal(evicted, null);
      // Last 3 should exist
      const lastTrace = await adapter2.getTraceByCorrelation('c4');
      assert.ok(lastTrace);
    });
  });

  describe('wrapPool', () => {
    it('wraps pool.query and returns original result', async () => {
      const fakeResult = { rowCount: 3, rows: [{ id: 1 }, { id: 2 }, { id: 3 }] };
      const fakePool = {
        query: async () => fakeResult,
      };

      const wrapped = adapter.wrapPool(fakePool);
      const result = await wrapped.query('SELECT * FROM users WHERE id = $1', [42]);
      assert.equal(result.rowCount, 3);
    });

    it('tracks query errors without breaking them', async () => {
      const fakePool = {
        query: async () => { throw new Error('syntax error'); },
      };

      const wrapped = adapter.wrapPool(fakePool);
      await assert.rejects(() => wrapped.query('INVALID SQL'), { message: 'syntax error' });
    });
  });

  describe('durable persistence', () => {
    it('writes captured traces through to durable storage', async () => {
      const persisted = [];
      const durableStorage = {
        async storeTrace(trace) {
          persisted.push(structuredClone(trace));
        },
        async getTracesBySession() { return []; },
        async getTraceByCorrelation() { return null; },
      };

      const durableAdapter = new DebugProbeTraceAdapter({ maxTraces: 100, storage: durableStorage });
      const middleware = durableAdapter.createMiddleware();
      const req = {
        method: 'GET', path: '/persist', originalUrl: '/persist',
        ip: '127.0.0.1', query: {}, body: null,
        headers: { 'x-sentinel-session': 'sess-persist', 'x-sentinel-correlation': 'corr-persist' },
        get: (name) => req.headers[name.toLowerCase()],
      };
      const res = { statusCode: 202, _headers: {}, getHeaders: () => ({}), setHeader: () => {}, end: () => {} };

      middleware(req, res, () => {});
      res.end();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(persisted.length, 1);
      assert.equal(persisted[0].sessionId, 'sess-persist');
      assert.equal(persisted[0].correlationId, 'corr-persist');
      assert.equal(persisted[0].response.statusCode, 202);
    });

    it('merges durable traces with the in-memory hot cache', async () => {
      const durableStorage = {
        async storeTrace() {},
        async getTracesBySession() {
          return [{
            correlationId: 'db-1',
            sessionId: 'sess-merge',
            request: { method: 'GET', path: '/from-db', url: '/from-db' },
            response: { statusCode: 200, durationMs: 5 },
            queries: [],
            createdAt: 1,
          }];
        },
        async getTraceByCorrelation() { return null; },
      };

      const durableAdapter = new DebugProbeTraceAdapter({ maxTraces: 100, storage: durableStorage });
      durableAdapter._store({
        correlationId: 'mem-1',
        sessionId: 'sess-merge',
        request: { method: 'POST', path: '/from-memory', url: '/from-memory' },
        response: { statusCode: 201, durationMs: 8 },
        queries: [],
        createdAt: 2,
      });

      const traces = await durableAdapter.getTraces('sess-merge');
      assert.equal(traces.length, 2);
      assert.deepEqual(traces.map((t) => t.correlationId), ['db-1', 'mem-1']);
    });
  });

  describe('clear', () => {
    it('removes all traces', async () => {
      adapter._store({
        correlationId: 'c1', sessionId: 's1',
        request: {}, response: {}, queries: [], createdAt: Date.now(),
      });
      assert.equal(adapter.size, 1);

      adapter.clear();
      assert.equal(adapter.size, 0);
    });
  });

  // ── Circuit breaker — isFailure predicate ───────────────────────────────

  describe('circuit breaker isFailure predicate', () => {
    it('does not count 4xx errors as circuit failures', async () => {
      const remoteAdapter = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'k',
        maxTraces: 100,
      });

      const err4xx = new Error('Not Found');
      err4xx.status = 404;
      const isFailure = remoteAdapter._remoteBreaker.isFailure;
      assert.equal(isFailure(err4xx), false, '404 should NOT be a circuit failure');
    });

    it('counts 5xx and network errors as circuit failures', async () => {
      const remoteAdapter = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'k',
        maxTraces: 100,
      });

      const isFailure = remoteAdapter._remoteBreaker.isFailure;
      const err5xx = new Error('Server Error');
      err5xx.status = 500;
      assert.equal(isFailure(err5xx), true, '500 should be a circuit failure');

      const networkErr = new Error('ECONNREFUSED');
      assert.equal(isFailure(networkErr), true, 'Network error should be a circuit failure');
    });
  });

  // ── getTraces — circuit open / fetch failure branches ───────────────────

  describe('getTraces — remote failure branches', () => {
    it('falls through to local store when remote fetch throws (non-circuit-open)', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => { throw new Error('ECONNREFUSED'); };

      try {
        const remoteAdapter = new DebugProbeTraceAdapter({
          baseUrl: 'http://probe.local',
          apiKey: 'k',
          maxTraces: 100,
        });

        // Pre-seed a local trace
        remoteAdapter._store({
          correlationId: 'local-cid',
          sessionId: 'sess-fallback',
          request: { method: 'GET', path: '/local' },
          response: { statusCode: 200, durationMs: 1 },
          queries: [],
          createdAt: Date.now(),
        });

        const traces = await remoteAdapter.getTraces('sess-fallback');
        // Should fall through to local store and return the seeded trace
        assert.equal(traces.length, 1);
        assert.equal(traces[0].correlationId, 'local-cid');
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('silently falls back when circuit is OPEN (no warning logged for isCircuitOpen)', async () => {
      const remoteAdapter = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'k',
        maxTraces: 100,
        // Low threshold to trip circuit quickly
      });

      // Force circuit OPEN by driving failures past the threshold
      remoteAdapter._remoteBreaker.state = 'OPEN';
      remoteAdapter._remoteBreaker._openedAt = Date.now() - 1; // already open

      // Pre-seed local trace
      remoteAdapter._store({
        correlationId: 'open-cid',
        sessionId: 'sess-open',
        request: { method: 'GET', path: '/x' },
        response: { statusCode: 200, durationMs: 1 },
        queries: [],
        createdAt: Date.now(),
      });

      // Should not throw; circuit OPEN → fallback undefined → CircuitOpenError caught → local store
      const traces = await remoteAdapter.getTraces('sess-open');
      assert.equal(traces.length, 1);
      assert.equal(traces[0].correlationId, 'open-cid');
    });
  });

  // ── getTraceByCorrelation — durable storage error path ──────────────────

  describe('getTraceByCorrelation — storage error path', () => {
    it('warns and returns null when durable storage throws', async () => {
      const errorStorage = {
        async storeTrace() {},
        async getTracesBySession() { return []; },
        async getTraceByCorrelation() { throw new Error('DB connection lost'); },
      };

      const durableAdapter = new DebugProbeTraceAdapter({
        maxTraces: 100,
        storage: errorStorage,
      });

      // Not in cache, not in memory — triggers durable path which will throw
      const result = await durableAdapter.getTraceByCorrelation('missing-cid');
      assert.equal(result, null);
    });
  });

  // ── getTraces — time window filtering ───────────────────────────────────

  describe('getTraces — time window filtering', () => {
    it('filters traces by fromTime', async () => {
      const now = Date.now();
      const a = { correlationId: 'old', sessionId: 'sess-time', request: {}, response: {}, queries: [], createdAt: now - 10000 };
      const b = { correlationId: 'new', sessionId: 'sess-time', request: {}, response: {}, queries: [], createdAt: now };
      adapter._store(a);
      adapter._store(b);

      const traces = await adapter.getTraces('sess-time', { since: now - 5000 });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].correlationId, 'new');
    });

    it('filters traces by toTime', async () => {
      const now = Date.now();
      const a = { correlationId: 'old-t', sessionId: 'sess-time2', request: {}, response: {}, queries: [], createdAt: now - 10000 };
      const b = { correlationId: 'new-t', sessionId: 'sess-time2', request: {}, response: {}, queries: [], createdAt: now };
      adapter._store(a);
      adapter._store(b);

      const traces = await adapter.getTraces('sess-time2', { until: now - 5000 });
      assert.equal(traces.length, 1);
      assert.equal(traces[0].correlationId, 'old-t');
    });
  });

  // ── _store — durable write failure suppression ───────────────────────────

  describe('_store — durable write failure', () => {
    it('swallows storeTrace errors and continues', async () => {
      const failStorage = {
        async storeTrace() { throw new Error('write error'); },
        async getTracesBySession() { return []; },
        async getTraceByCorrelation() { return null; },
      };

      const durableAdapter = new DebugProbeTraceAdapter({ maxTraces: 100, storage: failStorage });

      // Should not throw even if persistence fails
      durableAdapter._store({
        correlationId: 'sw-cid', sessionId: 'sw-sess',
        request: {}, response: {}, queries: [], createdAt: Date.now(),
      });

      // Give the fire-and-forget promise a chance to settle
      await new Promise(resolve => setImmediate(resolve));

      // Trace is still in memory
      assert.equal(durableAdapter.size, 1);
    });
  });

  // ── _evict — last entry in session cleans up sessionIndex ────────────────

  describe('_evict — sessionIndex cleanup', () => {
    it('removes sessionIndex entry when last correlationId for session is evicted', () => {
      adapter._store({
        correlationId: 'only-one', sessionId: 'sess-evict',
        request: {}, response: {}, queries: [], createdAt: Date.now(),
      });

      assert.ok(adapter.sessionIndex.has('sess-evict'));

      adapter._evict('only-one');

      // sessionIndex key should be cleaned up
      assert.ok(!adapter.sessionIndex.has('sess-evict'));
      assert.equal(adapter.size, 0);
    });
  });

  // ── _fetchJSON — non-ok response error with .status ──────────────────────

  describe('_fetchJSON — HTTP error branch', () => {
    it('throws an error with .status when remote returns non-ok', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: false,
        status: 503,
        async json() { return {}; },
      });

      const remoteAdapter = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'k',
        maxTraces: 100,
      });

      try {
        await assert.rejects(
          () => remoteAdapter._fetchJSON('/api/test'),
          (err) => {
            assert.ok(err.message.includes('503'));
            assert.equal(err.status, 503);
            return true;
          },
        );
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ── _fetchRemoteTraces — since/until params + default event type ─────────

  describe('_fetchRemoteTraces — query params and default event type', () => {
    it('sets fromTime and toTime query params when since/until provided', async () => {
      let capturedUrl = '';
      const originalFetch = global.fetch;
      global.fetch = async (url) => {
        capturedUrl = url;
        return {
          ok: true,
          async json() { return { events: [], total: 0 }; },
        };
      };

      const remoteAdapter = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'k',
        maxTraces: 100,
      });

      try {
        await remoteAdapter._fetchRemoteTraces('sess-q', { since: 1000, until: 2000, limit: 10 });
        assert.ok(capturedUrl.includes('fromTime=1000'), `Expected fromTime in URL: ${capturedUrl}`);
        assert.ok(capturedUrl.includes('toTime=2000'), `Expected toTime in URL: ${capturedUrl}`);
      } finally {
        global.fetch = originalFetch;
      }
    });

    it('groups events with unknown type under the same correlationId (default branch)', async () => {
      const originalFetch = global.fetch;
      global.fetch = async () => ({
        ok: true,
        async json() {
          return {
            events: [
              {
                id: 'e1',
                correlationId: 'corr-x',
                sessionId: 'sess-x',
                type: 'unknown-event-type',
                timestamp: 100,
                data: { whatever: true },
              },
            ],
            total: 1,
          };
        },
      });

      const remoteAdapter = new DebugProbeTraceAdapter({
        baseUrl: 'http://probe.local',
        apiKey: 'k',
        maxTraces: 100,
      });

      try {
        const traces = await remoteAdapter._fetchRemoteTraces('sess-x', {});
        // The unknown event type should still produce a grouped entry
        assert.equal(traces.length, 1);
        assert.equal(traces[0].correlationId, 'corr-x');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  // ── wrapPool — _recordQuery inside request context ────────────────────────

  describe('wrapPool — _recordQuery in request context', () => {
    it('attaches SQL query to trace entry when called inside middleware context', async () => {
      const middleware = adapter.createMiddleware();
      const req = {
        method: 'GET', path: '/traced', originalUrl: '/traced',
        ip: '127.0.0.1', query: {}, body: null,
        headers: {
          'x-sentinel-session': 'sess-query',
          'x-sentinel-correlation': 'corr-query',
        },
        get: (name) => req.headers[name.toLowerCase()],
      };
      const res = {
        statusCode: 200, _headers: {},
        getHeaders: () => ({}),
        setHeader: () => {},
        end: () => {},
      };

      const fakePool = { query: async () => ({ rowCount: 1, rows: [{ id: 42 }] }) };
      const wrapped = adapter.wrapPool(fakePool);

      await new Promise((resolve) => {
        middleware(req, res, async () => {
          await wrapped.query('SELECT id FROM users WHERE id = $1', [42]);
          resolve();
        });
      });

      res.end();
      await new Promise(resolve => setImmediate(resolve));

      const traces = await adapter.getTraces('sess-query');
      assert.equal(traces.length, 1);
      assert.equal(traces[0].payload.queryCount, 1);
      assert.equal(traces[0].payload.queries[0].sql, 'SELECT id FROM users WHERE id = $1');
    });
  });
});

// ── Gap 4: ensureRemoteSession legacy-schema fallback ──

describe('DebugProbeTraceAdapter.ensureRemoteSession legacy fallback (Gap 4)', () => {
  it('retries with tags-only body when legacy .strict() schema returns 400', async () => {
    const origFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (calls.length === 1) {
        return { ok: false, status: 400, statusText: 'Bad Request',
          json: async () => ({ error: 'Validation failed' }) };
      }
      return { ok: true, status: 201, json: async () => ({ id: 'remote-xyz' }) };
    };
    try {
      const adapter = new DebugProbeTraceAdapter({ baseUrl: 'http://x', apiKey: 'k' });
      const res = await adapter.ensureRemoteSession({
        id: 'sent-1',
        projectId: 'easynup-prod',
        metadata: { source: 'test' },
      });
      assert.equal(res.ok, true);
      assert.equal(res.remoteSessionId, 'remote-xyz');
      assert.equal(res.degraded, 'legacy-schema');
      assert.equal(calls.length, 2);
      assert.ok(calls[0].body.projectId, 'first call sends structured fields');
      assert.ok(!calls[1].body.projectId, 'second call drops projectId');
      assert.ok(!calls[1].body.metadata, 'second call drops metadata');
    } finally {
      global.fetch = origFetch;
    }
  });

  it('does not retry on non-400 failures', async () => {
    const origFetch = global.fetch;
    let count = 0;
    global.fetch = async () => {
      count++;
      return { ok: false, status: 500, statusText: 'Server Error',
        json: async () => ({}) };
    };
    try {
      const adapter = new DebugProbeTraceAdapter({ baseUrl: 'http://x', apiKey: 'k' });
      const res = await adapter.ensureRemoteSession({ id: 's1', projectId: 'p1' });
      assert.equal(res.ok, false);
      assert.equal(count, 1);
    } finally {
      global.fetch = origFetch;
    }
  });
});

// ── Gap 10: subscribe() WebSocket bridge ─────

describe('DebugProbeTraceAdapter.subscribe (Gap 10)', () => {
  it('returns a no-op unsubscribe when baseUrl is not configured', async () => {
    const adapter = new DebugProbeTraceAdapter({ baseUrl: null });
    const unsubscribe = await adapter.subscribe('sess-x', () => {});
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe(); // must not throw
  });

  it('returns a no-op when listener is not a function', async () => {
    const adapter = new DebugProbeTraceAdapter({ baseUrl: 'http://x' });
    const unsubscribe = await adapter.subscribe('sess-x', null);
    assert.equal(typeof unsubscribe, 'function');
    unsubscribe();
  });

  it('connects, subscribes, receives events and can be unsubscribed', async () => {
    const { WebSocketServer } = await import('ws');
    const http = await import('node:http');

    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const received = [];
    let subscribedSessionId = null;
    let resolveClose;
    const closed = new Promise((r) => { resolveClose = r; });

    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      assert.equal(url.searchParams.get('token'), 'test-key');

      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'subscribe') {
          subscribedSessionId = msg.sessionId;
          // push a synthetic event
          ws.send(JSON.stringify({
            type: 'event',
            sessionId: msg.sessionId,
            event: { id: 'e1', type: 'http.request' },
          }));
        }
      });
      ws.on('close', () => resolveClose());
    });

    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    const adapter = new DebugProbeTraceAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      apiKey: 'test-key',
    });
    // Map Sentinel sessionId → remote id
    adapter._sessionMap.set('sentinel-sess', 'remote-sess');

    const unsubscribe = await adapter.subscribe('sentinel-sess', (evt) => {
      received.push(evt);
    });

    // Wait up to 1s for the event
    const deadline = Date.now() + 1000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(subscribedSessionId, 'remote-sess');
    assert.equal(received.length, 1);
    assert.equal(received[0].id, 'e1');

    unsubscribe();
    await closed;
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
});
