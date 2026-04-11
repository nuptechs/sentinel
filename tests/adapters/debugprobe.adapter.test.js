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
        const res = { statusCode: 200, _headers: {}, getHeaders: () => ({}), end: () => {} };
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
});
