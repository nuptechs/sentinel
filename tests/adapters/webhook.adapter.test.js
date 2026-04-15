// ─────────────────────────────────────────────
// Tests — WebhookNotificationAdapter
// D1 D6 D7 D8 D9
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebhookNotificationAdapter } from '../../src/adapters/notification/webhook.adapter.js';

// ── Fetch mock ────────────────────────────────

let _originalFetch;
let _capturedCalls = [];
let _responseQueue = [];

function mockFetch() {
  _originalFetch = globalThis.fetch;
  _capturedCalls = [];
  _responseQueue = [];
  globalThis.fetch = async (url, opts) => {
    _capturedCalls.push({ url, ...opts });
    const res = _responseQueue.shift();
    if (res instanceof Error) throw res;
    return { ok: true, status: 200, ...res };
  };
}

function restoreFetch() {
  if (_originalFetch !== undefined) globalThis.fetch = _originalFetch;
}

function queueOk() { _responseQueue.push({ ok: true, status: 200 }); }
function queueError(msg = 'fetch failed') { _responseQueue.push(new Error(msg)); }

// ── Mock Finding ──────────────────────────────

function makeFinding(overrides = {}) {
  return {
    id: 'find-001',
    title: 'Login button broken',
    status: 'open',
    severity: 'high',
    toJSON: () => ({ id: 'find-001', title: 'Login button broken', status: 'open', ...overrides }),
    ...overrides,
  };
}

// ── D8: isConfigured ─────────────────────────

describe('WebhookNotificationAdapter.isConfigured (D8)', () => {
  it('returns true when url is set', () => {
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/sentinel' });
    assert.equal(a.isConfigured(), true);
  });

  it('returns false when url is empty string (D7)', () => {
    const a = new WebhookNotificationAdapter({ url: '' });
    assert.equal(a.isConfigured(), false);
  });

  it('returns false when url is null (D7)', () => {
    const a = new WebhookNotificationAdapter({ url: null });
    assert.equal(a.isConfigured(), false);
  });
});

// ── D1 D9: HTTP request structure ────────────

describe('WebhookNotificationAdapter._send HTTP structure (D1 D9)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('sends POST request to configured URL (D1)', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/events' });
    await a.onFindingCreated(makeFinding());
    assert.equal(_capturedCalls.length, 1);
    assert.equal(_capturedCalls[0].url, 'https://hooks.example.com/events');
    assert.equal(_capturedCalls[0].method, 'POST');
  });

  it('sends Content-Type: application/json (D9)', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await a.onFindingCreated(makeFinding());
    assert.equal(_capturedCalls[0].headers['Content-Type'], 'application/json');
  });

  it('body is valid JSON with event, timestamp, data fields (D9)', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await a.onFindingCreated(makeFinding());
    const parsed = JSON.parse(_capturedCalls[0].body);
    assert.ok(parsed.event);
    assert.ok(parsed.timestamp);
    assert.ok(parsed.data);
  });

  it('data.id matches finding.id (D9)', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await a.onFindingCreated(makeFinding());
    const parsed = JSON.parse(_capturedCalls[0].body);
    assert.equal(parsed.data.id, 'find-001');
  });
});

// ── D8: Event name mapping ────────────────────

describe('WebhookNotificationAdapter event names (D8)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('onFindingCreated sends event "finding.created"', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await a.onFindingCreated(makeFinding());
    assert.equal(JSON.parse(_capturedCalls[0].body).event, 'finding.created');
  });

  it('onDiagnosisReady sends event "finding.diagnosed"', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await a.onDiagnosisReady(makeFinding());
    assert.equal(JSON.parse(_capturedCalls[0].body).event, 'finding.diagnosed');
  });

  it('onCorrectionProposed sends event "finding.correction_proposed"', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await a.onCorrectionProposed(makeFinding());
    assert.equal(JSON.parse(_capturedCalls[0].body).event, 'finding.correction_proposed');
  });
});

// ── D8 D9: HMAC signing ───────────────────────

describe('WebhookNotificationAdapter HMAC signature (D8 D9)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('adds X-Sentinel-Signature header when secret is set (D8)', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e', secret: 'my-hmac-secret' });
    await a.onFindingCreated(makeFinding());
    assert.ok(_capturedCalls[0].headers['X-Sentinel-Signature']);
  });

  it('signature follows format sha256=<hexdigest> (D9)', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e', secret: 'my-hmac-secret' });
    await a.onFindingCreated(makeFinding());
    const sig = _capturedCalls[0].headers['X-Sentinel-Signature'];
    assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  });

  it('signature is valid HMAC-SHA256 of the raw body (D9)', async () => {
    queueOk();
    const secret = 'test-webhook-secret';
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e', secret });
    await a.onFindingCreated(makeFinding());
    const body = _capturedCalls[0].body;
    const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    assert.equal(_capturedCalls[0].headers['X-Sentinel-Signature'], expected);
  });

  it('does NOT add signature header when no secret (D7)', async () => {
    queueOk();
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await a.onFindingCreated(makeFinding());
    assert.equal(_capturedCalls[0].headers['X-Sentinel-Signature'], undefined);
  });
});

// ── D6: Error propagation ─────────────────────

describe('WebhookNotificationAdapter error handling (D6)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('propagates fetch network errors (D6)', async () => {
    queueError('Connection refused');
    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e' });
    await assert.rejects(() => a.onFindingCreated(makeFinding()), /Connection refused/);
  });
});

// ── D7: Timeout via AbortController ──────────

describe('WebhookNotificationAdapter timeout (D7)', () => {
  afterEach(restoreFetch);

  it('aborts request after timeoutMs (D7)', async () => {
    // Mock a fetch that never resolves, but AbortController will abort it
    _capturedCalls = [];
    globalThis.fetch = async (url, opts) => {
      _capturedCalls.push({ url, opts });
      return new Promise((resolve, reject) => {
        // Listen for abort
        opts.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    };

    const a = new WebhookNotificationAdapter({ url: 'https://hooks.example.com/e', timeoutMs: 10 });
    await assert.rejects(() => a.onFindingCreated(makeFinding()), /aborted|abort/i);
    restoreFetch();
  });
});
