// ─────────────────────────────────────────────
// Tests — Probe Webhook Receiver
// POST /api/probe-webhooks (HMAC-SHA256 auth, Stripe-style)
// GET  /api/probe-webhooks (inspection)
// ─────────────────────────────────────────────

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';

import { createApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';

const SECRET = 'a'.repeat(48);

function signBody(secret, timestamp, rawBody) {
  const hmac = createHmac('sha256', secret);
  hmac.update(`${timestamp}.${rawBody}`);
  return `sha256=${hmac.digest('hex')}`;
}

function postRaw(server, path, rawBody, headers = {}) {
  const addr = server.address();
  return new Promise((resolve, reject) => {
    const r = http.request(
      `http://127.0.0.1:${addr.port}${path}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      },
    );
    r.on('error', reject);
    if (rawBody) r.write(rawBody);
    r.end();
  });
}

function get(server, path) {
  const addr = server.address();
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${addr.port}${path}`, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    }).on('error', reject);
  });
}

describe('Probe Webhook Receiver', () => {
  let server;
  let originalSecret;
  let originalProjectId;
  let storage;
  let sessionCalls;

  before(async () => {
    originalSecret = process.env.PROBE_WEBHOOK_SECRET;
    process.env.PROBE_WEBHOOK_SECRET = SECRET;
    originalProjectId = process.env.SENTINEL_PROBE_PROJECT_ID;
    process.env.SENTINEL_PROBE_PROJECT_ID = 'debug-probe';

    storage = new MemoryStorageAdapter();
    sessionCalls = { getOrCreate: [], complete: [] };
    const mockServices = {
      sessions: {
        async getOrCreate(sessionId, opts) {
          sessionCalls.getOrCreate.push({ sessionId, ...opts });
          return { id: sessionId };
        },
        async complete(sessionId) {
          sessionCalls.complete.push(sessionId);
          return { id: sessionId, status: 'completed' };
        },
      },
      findings: {},
      projects: {},
    };
    const app = createApp(mockServices, { storage });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
  });

  after(async () => {
    if (originalSecret === undefined) delete process.env.PROBE_WEBHOOK_SECRET;
    else process.env.PROBE_WEBHOOK_SECRET = originalSecret;
    if (originalProjectId === undefined) delete process.env.SENTINEL_PROBE_PROJECT_ID;
    else process.env.SENTINEL_PROBE_PROJECT_ID = originalProjectId;
    await new Promise((r) => server.close(r));
  });

  it('accepts a valid signed delivery and stores it', async () => {
    const payload = { event: 'session.created', data: { sessionId: 'sess-1' }, deliveryId: 'd-1' };
    const raw = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signBody(SECRET, ts, raw);

    const resp = await postRaw(server, '/api/probe-webhooks', raw, {
      'X-Probe-Event': 'session.created',
      'X-Probe-Timestamp': ts,
      'X-Probe-Signature': sig,
      'X-Probe-Delivery': 'd-1',
    });

    assert.equal(resp.status, 200);
    assert.equal(resp.body.success, true);
    assert.equal(resp.body.deliveryId, 'd-1');

    const inspect = await get(server, '/api/probe-webhooks');
    assert.equal(inspect.status, 200);
    assert.equal(inspect.body.data.configured, true);
    assert.ok(inspect.body.data.receivedTotal >= 1);
    assert.ok(inspect.body.data.events.some((e) => e.deliveryId === 'd-1'));
  });

  it('rejects missing signature header (400)', async () => {
    const resp = await postRaw(server, '/api/probe-webhooks', '{}', {
      'X-Probe-Timestamp': String(Math.floor(Date.now() / 1000)),
    });
    assert.equal(resp.status, 400);
    assert.match(resp.body.error, /signature|timestamp/i);
  });

  it('rejects invalid signature (401)', async () => {
    const raw = JSON.stringify({ a: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    const resp = await postRaw(server, '/api/probe-webhooks', raw, {
      'X-Probe-Timestamp': ts,
      'X-Probe-Signature': 'sha256=deadbeef',
    });
    assert.equal(resp.status, 401);
    assert.match(resp.body.error, /signature/i);
  });

  it('rejects timestamps outside ±5min window (401)', async () => {
    const raw = JSON.stringify({ a: 1 });
    const ts = String(Math.floor(Date.now() / 1000) - 600); // 10 min old
    const sig = signBody(SECRET, ts, raw);
    const resp = await postRaw(server, '/api/probe-webhooks', raw, {
      'X-Probe-Timestamp': ts,
      'X-Probe-Signature': sig,
    });
    assert.equal(resp.status, 401);
    assert.match(resp.body.error, /window|timestamp/i);
  });

  it('rejects non-numeric timestamp (400)', async () => {
    const resp = await postRaw(server, '/api/probe-webhooks', '{}', {
      'X-Probe-Timestamp': 'not-a-number',
      'X-Probe-Signature': 'sha256=deadbeef',
    });
    assert.equal(resp.status, 400);
  });

  it('rejects body tampering — signature no longer matches', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signBody(SECRET, ts, '{"original":true}');
    const resp = await postRaw(server, '/api/probe-webhooks', '{"tampered":true}', {
      'X-Probe-Timestamp': ts,
      'X-Probe-Signature': sig,
    });
    assert.equal(resp.status, 401);
  });

  it('persists delivery to storage and is idempotent on replay', async () => {
    const payload = { event: 'session.created', data: { sessionId: 'sess-persist' }, deliveryId: 'd-persist' };
    const raw = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signBody(SECRET, ts, raw);
    const headers = {
      'X-Probe-Event': 'session.created',
      'X-Probe-Timestamp': ts,
      'X-Probe-Signature': sig,
      'X-Probe-Delivery': 'd-persist',
    };

    const r1 = await postRaw(server, '/api/probe-webhooks', raw, headers);
    const r2 = await postRaw(server, '/api/probe-webhooks', raw, headers);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);

    const inbox = await get(server, '/api/probe-webhooks');
    assert.equal(inbox.body.data.persistent, true);
    const matches = inbox.body.data.events.filter((e) => e.deliveryId === 'd-persist');
    assert.equal(matches.length, 1, 'replay must not duplicate');
  });

  it('mirrors session.created and session.completed into SessionService', async () => {
    const sessionId = 'sess-mirror';

    // created
    const createdPayload = { event: 'session.created', data: { sessionId }, deliveryId: 'd-mirror-1' };
    const rawC = JSON.stringify(createdPayload);
    const tsC = String(Math.floor(Date.now() / 1000));
    await postRaw(server, '/api/probe-webhooks', rawC, {
      'X-Probe-Event': 'session.created',
      'X-Probe-Timestamp': tsC,
      'X-Probe-Signature': signBody(SECRET, tsC, rawC),
      'X-Probe-Delivery': 'd-mirror-1',
    });

    // completed
    const completedPayload = { event: 'session.completed', data: { sessionId }, deliveryId: 'd-mirror-2' };
    const rawD = JSON.stringify(completedPayload);
    const tsD = String(Math.floor(Date.now() / 1000));
    await postRaw(server, '/api/probe-webhooks', rawD, {
      'X-Probe-Event': 'session.completed',
      'X-Probe-Timestamp': tsD,
      'X-Probe-Signature': signBody(SECRET, tsD, rawD),
      'X-Probe-Delivery': 'd-mirror-2',
    });

    // Mirroring is best-effort and happens after the HTTP response;
    // wait a tick for the microtask queue to drain.
    await new Promise((r) => setImmediate(r));

    const createdMatch = sessionCalls.getOrCreate.filter((c) => c.sessionId === sessionId);
    assert.ok(createdMatch.length >= 1, 'getOrCreate must be called for session mirror');
    assert.ok(
      sessionCalls.complete.includes(sessionId),
      'complete must be called for session.completed',
    );
  });

  it('bypasses apiKeyAuth (no API key required)', async () => {
    // Even without any Authorization/X-API-Key header, the route should be reachable
    // (but still rejected for invalid signature, not for missing auth).
    const resp = await postRaw(server, '/api/probe-webhooks', '{}', {
      'X-Probe-Timestamp': String(Math.floor(Date.now() / 1000)),
      'X-Probe-Signature': 'sha256=nope',
    });
    // If apiKeyAuth intercepted, we'd get 401 with /api key/i; instead we get our own signature error.
    assert.equal(resp.status, 401);
    assert.match(resp.body.error, /signature/i);
  });
});
