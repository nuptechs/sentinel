// ─────────────────────────────────────────────
// Tests — Express App Factory & Readiness Probe
// Tests /ready endpoint with various adapter
// configurations and MCP error branches.
// ─────────────────────────────────────────────

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { SessionService } from '../../src/core/services/session.service.js';
import { FindingService } from '../../src/core/services/finding.service.js';

// ── Helpers ─────────────────────────────────

function req(server, method, path, body = null, headers = {}) {
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}${path}`;
  return new Promise((resolve, reject) => {
    const r = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, body: data }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

function minimalServices(storage) {
  return {
    sessions: new SessionService({ storage }),
    findings: new FindingService({ storage }),
  };
}

async function startServer(services, adapters = null) {
  const app = createApp(services, adapters);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function stopServer(server) {
  await new Promise(resolve => server.close(resolve));
}

// ── /ready endpoint ─────────────────────────

describe('/ready — Readiness Probe', () => {
  let storage;

  before(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();
  });

  after(async () => {
    await storage.close();
  });

  it('returns healthy with no adapters', async () => {
    const server = await startServer(minimalServices(storage), null);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'healthy');
      assert.ok(res.body.timestamp);
      assert.ok(res.body.uptime >= 0);
      assert.deepEqual(res.body.components, {});
    } finally {
      await stopServer(server);
    }
  });

  it('returns healthy with empty adapters object', async () => {
    const server = await startServer(minimalServices(storage), {});
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'healthy');
    } finally {
      await stopServer(server);
    }
  });

  // ── Storage component ───────────────────

  it('returns healthy storage (memory — no pool)', async () => {
    const adapters = {
      storage: { /* no pool property → memory type */ },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.storage.status, 'healthy');
      assert.equal(res.body.components.storage.type, 'memory');
    } finally {
      await stopServer(server);
    }
  });

  it('returns healthy storage (postgres — query succeeds)', async () => {
    const adapters = {
      storage: {
        pool: {
          query: async () => ({ rows: [{ '?column?': 1 }] }),
        },
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.storage.status, 'healthy');
      assert.equal(res.body.components.storage.type, 'postgres');
    } finally {
      await stopServer(server);
    }
  });

  it('returns unhealthy storage (postgres — query fails) → 503', async () => {
    const adapters = {
      storage: {
        pool: {
          query: async () => { throw new Error('Connection refused'); },
        },
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 503);
      assert.equal(res.body.status, 'unhealthy');
      assert.equal(res.body.components.storage.status, 'unhealthy');
      assert.equal(res.body.components.storage.type, 'postgres');
    } finally {
      await stopServer(server);
    }
  });

  // ── Trace component ─────────────────────

  it('returns healthy trace (circuit CLOSED)', async () => {
    const adapters = {
      trace: {
        isConfigured: () => true,
        getCircuitStatus: () => ({ state: 'CLOSED' }),
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.trace.status, 'healthy');
      assert.equal(res.body.components.trace.type, 'debugprobe');
      assert.equal(res.body.components.trace.circuit, 'CLOSED');
    } finally {
      await stopServer(server);
    }
  });

  it('returns degraded trace (circuit OPEN)', async () => {
    const adapters = {
      trace: {
        isConfigured: () => true,
        getCircuitStatus: () => ({ state: 'OPEN' }),
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'degraded');
      assert.equal(res.body.components.trace.status, 'degraded');
      assert.equal(res.body.components.trace.circuit, 'OPEN');
    } finally {
      await stopServer(server);
    }
  });

  it('returns degraded trace (circuit HALF_OPEN)', async () => {
    const adapters = {
      trace: {
        isConfigured: () => true,
        getCircuitStatus: () => ({ state: 'HALF_OPEN' }),
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'degraded');
      assert.equal(res.body.components.trace.status, 'degraded');
    } finally {
      await stopServer(server);
    }
  });

  it('returns unconfigured trace (no circuit, not configured)', async () => {
    const adapters = {
      trace: {
        isConfigured: () => false,
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'healthy');
      assert.equal(res.body.components.trace.status, 'unconfigured');
      assert.equal(res.body.components.trace.type, 'noop');
    } finally {
      await stopServer(server);
    }
  });

  it('returns healthy trace (no circuit, configured)', async () => {
    const adapters = {
      trace: {
        isConfigured: () => true,
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.trace.status, 'healthy');
      assert.equal(res.body.components.trace.type, 'active');
    } finally {
      await stopServer(server);
    }
  });

  // ── Analyzer component ──────────────────

  it('returns healthy analyzer (circuit CLOSED)', async () => {
    const adapters = {
      analyzer: {
        isConfigured: () => true,
        getCircuitStatus: () => ({ state: 'CLOSED' }),
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.analyzer.status, 'healthy');
      assert.equal(res.body.components.analyzer.type, 'manifest');
      assert.equal(res.body.components.analyzer.circuit, 'CLOSED');
    } finally {
      await stopServer(server);
    }
  });

  it('returns degraded analyzer (circuit OPEN)', async () => {
    const adapters = {
      analyzer: {
        isConfigured: () => true,
        getCircuitStatus: () => ({ state: 'OPEN' }),
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'degraded');
      assert.equal(res.body.components.analyzer.status, 'degraded');
    } finally {
      await stopServer(server);
    }
  });

  it('returns degraded analyzer (circuit HALF_OPEN)', async () => {
    const adapters = {
      analyzer: {
        isConfigured: () => true,
        getCircuitStatus: () => ({ state: 'HALF_OPEN' }),
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.analyzer.status, 'degraded');
    } finally {
      await stopServer(server);
    }
  });

  it('returns unconfigured analyzer (no circuit, not configured)', async () => {
    const adapters = {
      analyzer: {
        isConfigured: () => false,
      },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.analyzer.status, 'unconfigured');
      assert.equal(res.body.components.analyzer.type, 'noop');
    } finally {
      await stopServer(server);
    }
  });

  // ── AI component ────────────────────────

  it('returns healthy AI (configured)', async () => {
    const adapters = {
      ai: { isConfigured: () => true },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.ai.status, 'healthy');
      assert.equal(res.body.components.ai.type, 'claude');
    } finally {
      await stopServer(server);
    }
  });

  it('returns unconfigured AI', async () => {
    const adapters = {
      ai: { isConfigured: () => false },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.components.ai.status, 'unconfigured');
      assert.equal(res.body.components.ai.type, 'noop');
    } finally {
      await stopServer(server);
    }
  });

  // ── Combined scenarios ──────────────────

  it('all components healthy → 200', async () => {
    const adapters = {
      storage: { pool: { query: async () => ({}) } },
      trace: { isConfigured: () => true, getCircuitStatus: () => ({ state: 'CLOSED' }) },
      analyzer: { isConfigured: () => true, getCircuitStatus: () => ({ state: 'CLOSED' }) },
      ai: { isConfigured: () => true },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'healthy');
      assert.equal(Object.keys(res.body.components).length, 4);
    } finally {
      await stopServer(server);
    }
  });

  it('degraded component does not override unhealthy → 503', async () => {
    const adapters = {
      storage: { pool: { query: async () => { throw new Error('down'); } } },
      trace: { isConfigured: () => true, getCircuitStatus: () => ({ state: 'OPEN' }) },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 503);
      assert.equal(res.body.status, 'unhealthy');
      assert.equal(res.body.components.storage.status, 'unhealthy');
      assert.equal(res.body.components.trace.status, 'degraded');
    } finally {
      await stopServer(server);
    }
  });

  it('degraded alone stays 200', async () => {
    const adapters = {
      trace: { isConfigured: () => true, getCircuitStatus: () => ({ state: 'OPEN' }) },
      ai: { isConfigured: () => true },
    };
    const server = await startServer(minimalServices(storage), adapters);
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'degraded');
    } finally {
      await stopServer(server);
    }
  });
});

// ── MCP Routes ──────────────────────────────

describe('MCP Routes', () => {
  let storage;

  before(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();
  });

  after(async () => {
    await storage.close();
  });

  it('MCP routes are NOT registered when SENTINEL_MCP_ENABLED is unset', async () => {
    const prev = process.env.SENTINEL_MCP_ENABLED;
    delete process.env.SENTINEL_MCP_ENABLED;
    try {
      const server = await startServer(minimalServices(storage));
      try {
        const res = await req(server, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
        assert.equal(res.status, 404);
      } finally {
        await stopServer(server);
      }
    } finally {
      if (prev !== undefined) process.env.SENTINEL_MCP_ENABLED = prev;
    }
  });

  it('/mcp rejects GET without session ID', async () => {
    const prev = process.env.SENTINEL_MCP_ENABLED;
    process.env.SENTINEL_MCP_ENABLED = 'true';
    try {
      const server = await startServer(minimalServices(storage));
      try {
        const res = await req(server, 'GET', '/mcp');
        // GET without session → 400 (no valid session ID)
        assert.equal(res.status, 400);
        assert.ok(res.body.error);
      } finally {
        await stopServer(server);
      }
    } finally {
      if (prev !== undefined) process.env.SENTINEL_MCP_ENABLED = prev;
      else delete process.env.SENTINEL_MCP_ENABLED;
    }
  });

  it('/mcp rejects POST non-initialize without session ID', async () => {
    const prev = process.env.SENTINEL_MCP_ENABLED;
    process.env.SENTINEL_MCP_ENABLED = 'true';
    try {
      const server = await startServer(minimalServices(storage));
      try {
        const res = await req(server, 'POST', '/mcp', {
          jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error);
      } finally {
        await stopServer(server);
      }
    } finally {
      if (prev !== undefined) process.env.SENTINEL_MCP_ENABLED = prev;
      else delete process.env.SENTINEL_MCP_ENABLED;
    }
  });

  it('/messages rejects without valid session', async () => {
    const prev = process.env.SENTINEL_MCP_ENABLED;
    process.env.SENTINEL_MCP_ENABLED = 'true';
    try {
      const server = await startServer(minimalServices(storage));
      try {
        const res = await req(server, 'POST', '/messages?sessionId=nonexistent', {
          jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error);
      } finally {
        await stopServer(server);
      }
    } finally {
      if (prev !== undefined) process.env.SENTINEL_MCP_ENABLED = prev;
      else delete process.env.SENTINEL_MCP_ENABLED;
    }
  });

  it('/messages rejects without sessionId param', async () => {
    const prev = process.env.SENTINEL_MCP_ENABLED;
    process.env.SENTINEL_MCP_ENABLED = 'true';
    try {
      const server = await startServer(minimalServices(storage));
      try {
        const res = await req(server, 'POST', '/messages', {
          jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
        });
        assert.equal(res.status, 400);
        assert.ok(res.body.error);
      } finally {
        await stopServer(server);
      }
    } finally {
      if (prev !== undefined) process.env.SENTINEL_MCP_ENABLED = prev;
      else delete process.env.SENTINEL_MCP_ENABLED;
    }
  });
});

// ── App factory basics ──────────────────────

describe('createApp', () => {
  let storage;

  before(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();
  });

  after(async () => {
    await storage.close();
  });

  it('returns an express app', async () => {
    const app = createApp(minimalServices(storage));
    assert.equal(typeof app, 'function');
    assert.equal(typeof app.use, 'function');
  });

  it('/health is public (no auth required)', async () => {
    const server = await startServer(minimalServices(storage));
    try {
      const res = await req(server, 'GET', '/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
    } finally {
      await stopServer(server);
    }
  });

  it('/ready is public (no auth required)', async () => {
    const server = await startServer(minimalServices(storage));
    try {
      const res = await req(server, 'GET', '/ready');
      assert.equal(res.status, 200);
    } finally {
      await stopServer(server);
    }
  });

  it('sets security headers via helmet', async () => {
    const server = await startServer(minimalServices(storage));
    try {
      const res = await req(server, 'GET', '/health');
      // Helmet sets X-Content-Type-Options
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
    } finally {
      await stopServer(server);
    }
  });

  it('sets CORS headers', async () => {
    const server = await startServer(minimalServices(storage));
    try {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}/health`;
      const res = await new Promise((resolve, reject) => {
        const r = http.request(url, {
          method: 'OPTIONS',
          headers: { Origin: 'http://example.com', 'Access-Control-Request-Method': 'GET' },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
        });
        r.on('error', reject);
        r.end();
      });
      assert.ok(res.headers['access-control-allow-origin']);
    } finally {
      await stopServer(server);
    }
  });

  it('handles 404 for unknown routes', async () => {
    const server = await startServer(minimalServices(storage));
    try {
      const res = await req(server, 'GET', '/does-not-exist');
      assert.equal(res.status, 404);
    } finally {
      await stopServer(server);
    }
  });
});
