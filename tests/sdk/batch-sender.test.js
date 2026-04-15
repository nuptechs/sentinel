// ─────────────────────────────────────────────
// Tests — SDK BatchSender
// Ring buffer, circuit breaker, HTTP transport.
// 14-dimension coverage: D1 D2 D6 D7 D8 D9 D13
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { BatchSender } from '../../src/sdk/core/batch-sender.js';

// ── Fetch mock ──────────────────────────────

let _fetchCalls = [];
let _fetchQueue = [];
const originalFetch = globalThis.fetch;

function mockFetch() {
  _fetchCalls = [];
  _fetchQueue = [];
  globalThis.fetch = async (url, opts = {}) => {
    _fetchCalls.push({ url, method: opts.method, headers: opts.headers, body: opts.body, keepalive: opts.keepalive });
    const resp = _fetchQueue.shift();
    if (!resp) return { ok: true, status: 200, json: async () => ({ success: true }) };
    if (resp instanceof Error) throw resp;
    return {
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      json: async () => resp.json ?? { success: true },
    };
  };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

function queueOk(jsonBody = { success: true }) {
  _fetchQueue.push({ ok: true, status: 200, json: jsonBody });
}

function queueError(status = 500, message = 'Server error') {
  _fetchQueue.push({ ok: false, status, json: { error: { message } } });
}

function queueNetworkError(msg = 'Network failure') {
  _fetchQueue.push(new Error(msg));
}

function makeSender(overrides = {}) {
  return new BatchSender({
    url: 'http://localhost:7070',
    batchSize: 5,
    flushInterval: 60_000, // no auto-flush in tests
    maxBufferSize: 20,
    failureThreshold: 3,
    recoveryMs: 50, // very short for tests
    maxRetries: 0,  // no retries by default in unit tests
    ...overrides,
  });
}

// ── D1: Constructor ─────────────────────────

describe('BatchSender constructor', () => {
  it('throws when url is missing', () => {
    assert.throws(() => new BatchSender({}), /url is required/);
  });

  it('throws when url is empty string', () => {
    assert.throws(() => new BatchSender({ url: '' }), /url is required/);
  });

  it('strips trailing slash from url', () => {
    const s = new BatchSender({ url: 'http://localhost:7070/' });
    assert.equal(s._url, 'http://localhost:7070');
  });

  it('initialises with empty ring buffer and zero metrics', () => {
    const s = makeSender();
    assert.equal(s.bufferSize, 0);
    assert.equal(s.circuitState, 'closed');
    assert.deepEqual(s.metrics, { sent: 0, dropped: 0, retries: 0, breakerTrips: 0 });
  });

  it('stores apiKey', () => {
    const s = makeSender({ apiKey: 'sk-test' });
    assert.equal(s._apiKey, 'sk-test');
  });
});

// ── D2 + D8: Ring buffer ────────────────────

describe('Ring buffer (push)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('increments size on push', () => {
    const s = makeSender();
    s.push({ type: 'test' });
    assert.equal(s.bufferSize, 1);
  });

  it('accepts array of events', () => {
    const s = makeSender();
    s.push([{ type: 'a' }, { type: 'b' }, { type: 'c' }]);
    assert.equal(s.bufferSize, 3);
  });

  it('does nothing when destroyed', () => {
    const s = makeSender();
    s._destroyed = true;
    s.push({ type: 'x' });
    assert.equal(s.bufferSize, 0);
  });

  it('drops oldest events when buffer full (capacity=5)', () => {
    const s = makeSender({ maxBufferSize: 5, batchSize: 999 });
    for (let i = 0; i < 5; i++) s.push({ seq: i });
    assert.equal(s.bufferSize, 5);
    assert.equal(s.metrics.dropped, 0);
    // Push 2 more — both evict one each
    s.push({ seq: 5 });
    s.push({ seq: 6 });
    assert.equal(s.bufferSize, 5); // capacity unchanged
    assert.equal(s.metrics.dropped, 2);
  });

  it('_drain returns events in FIFO order', () => {
    const s = makeSender({ batchSize: 999 });
    s.push([{ v: 1 }, { v: 2 }, { v: 3 }]);
    const drained = s._drain(3);
    assert.deepEqual(drained.map(e => e.v), [1, 2, 3]);
    assert.equal(s.bufferSize, 0);
  });

  it('_drain reads partial buffer correctly', () => {
    const s = makeSender({ batchSize: 999 });
    s.push([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
    const first = s._drain(2);
    assert.deepEqual(first.map(e => e.v), [1, 2]);
    assert.equal(s.bufferSize, 2);
    const second = s._drain(2);
    assert.deepEqual(second.map(e => e.v), [3, 4]);
  });

  it('_unshift re-queues events at front', () => {
    const s = makeSender({ batchSize: 999 });
    s.push([{ v: 1 }, { v: 2 }]);
    s._unshift([{ v: 0 }]);
    const drained = s._drain(3);
    assert.deepEqual(drained.map(e => e.v), [0, 1, 2]);
  });

  it('_unshift drops events when buffer full', () => {
    const s = makeSender({ maxBufferSize: 3, batchSize: 999 });
    s.push([{ v: 1 }, { v: 2 }, { v: 3 }]);
    s._unshift([{ v: 0 }]); // no room
    assert.equal(s.metrics.dropped, 1);
    assert.equal(s.bufferSize, 3);
  });

  it('auto-flushes when batchSize reached (D13-boundary)', async () => {
    queueOk();
    const s = makeSender({ batchSize: 3 });
    s.sessionId = 'sess-auto';
    s.push([{ v: 1 }, { v: 2 }, { v: 3 }]);
    // flush() is fire-and-forget from push(); wait for its async completion
    await new Promise(r => setTimeout(r, 50));
    assert.equal(s.metrics.sent, 3);
  });
});

// ── D1: Flush happy path ────────────────────

describe('flush() — happy path (D1)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('sends batch to /api/sessions/:id/events', async () => {
    queueOk();
    const s = makeSender();
    s.sessionId = 'sess-1';
    s.push([{ type: 'click' }, { type: 'scroll' }]);
    await s.flush();
    assert.equal(_fetchCalls.length, 1);
    assert.ok(_fetchCalls[0].url.includes('/api/sessions/sess-1/events'));
    assert.equal(_fetchCalls[0].method, 'POST');
    const body = JSON.parse(_fetchCalls[0].body);
    assert.equal(body.events.length, 2);
  });

  it('increments metrics.sent by batch length', async () => {
    queueOk();
    const s = makeSender();
    s.sessionId = 'sess-2';
    s.push([{ a: 1 }, { b: 2 }, { c: 3 }]);
    await s.flush();
    assert.equal(s.metrics.sent, 3);
    assert.equal(s.bufferSize, 0);
  });

  it('includes X-Sentinel-SDK header', async () => {
    queueOk();
    const s = makeSender({ apiKey: null });
    s.sessionId = 'sess-3';
    s.push({ x: 1 });
    await s.flush();
    assert.equal(_fetchCalls[0].headers['X-Sentinel-SDK'], 'browser/2.0');
  });

  it('includes X-Sentinel-Key header when apiKey set', async () => {
    queueOk();
    const s = makeSender({ apiKey: 'my-key' });
    s.sessionId = 'sess-4';
    s.push({ x: 1 });
    await s.flush();
    assert.equal(_fetchCalls[0].headers['X-Sentinel-Key'], 'my-key');
  });

  it('omits X-Sentinel-Key when no apiKey', async () => {
    queueOk();
    const s = makeSender({ apiKey: null });
    s.sessionId = 'sess-5';
    s.push({ x: 1 });
    await s.flush();
    assert.ok(!_fetchCalls[0].headers['X-Sentinel-Key']);
  });
});

// ── D7: Flush guards ─────────────────────────

describe('flush() — guards (D7)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('no-op when buffer empty', async () => {
    const s = makeSender();
    s.sessionId = 'sess-6';
    await s.flush();
    assert.equal(_fetchCalls.length, 0);
  });

  it('no-op when sessionId not set', async () => {
    const s = makeSender();
    s.push({ x: 1 });
    await s.flush();
    assert.equal(_fetchCalls.length, 0);
  });

  it('no-op when destroyed', async () => {
    const s = makeSender();
    s.sessionId = 'sess-7';
    s.push({ x: 1 });
    s._destroyed = true;
    await s.flush();
    assert.equal(_fetchCalls.length, 0);
  });

  it('no-op when already flushing (prevents double-send)', async () => {
    const s = makeSender();
    s.sessionId = 'sess-8';
    s.push({ x: 1 });
    s._flushing = true; // simulate in-progress flush
    await s.flush();
    assert.equal(_fetchCalls.length, 0);
    s._flushing = false;
  });
});

// ── D6 + D8: Circuit breaker ─────────────────

describe('Circuit breaker (D6 D8)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('starts in CLOSED state', () => {
    const s = makeSender();
    assert.equal(s.circuitState, 'closed');
  });

  it('opens circuit after failureThreshold consecutive failures', async () => {
    const s = makeSender({ failureThreshold: 2, recoveryMs: 60_000 });
    s.sessionId = 'sess-cb';
    for (let i = 0; i < 2; i++) {
      queueNetworkError();
      s.push({ x: i });
      await s.flush();
    }
    assert.equal(s.circuitState, 'open');
    assert.equal(s.metrics.breakerTrips, 1);
  });

  it('blocks flush when circuit OPEN', async () => {
    const s = makeSender({ failureThreshold: 1, recoveryMs: 60_000 });
    s.sessionId = 'sess-block';
    queueNetworkError();
    s.push({ x: 1 });
    await s.flush();
    assert.equal(s.circuitState, 'open');
    // Try to flush again — should be blocked
    s.push({ x: 2 });
    await s.flush();
    assert.equal(_fetchCalls.length, 1); // only 1 fetch attempt made
  });

  it('transitions to half-open after recoveryMs', async () => {
    const s = makeSender({ failureThreshold: 1, recoveryMs: 10 }); // 10ms
    s.sessionId = 'sess-ho';
    queueNetworkError();
    s.push({ x: 1 });
    await s.flush();
    assert.equal(s.circuitState, 'open');
    await new Promise(r => setTimeout(r, 30)); // wait > recoveryMs
    assert.ok(s._canSend()); // should allow one probe
  });

  it('closes circuit on success in half-open state', async () => {
    const s = makeSender({ failureThreshold: 1, recoveryMs: 10 });
    s.sessionId = 'sess-close';
    queueNetworkError();
    s.push({ x: 1 });
    await s.flush();
    assert.equal(s.circuitState, 'open');
    await new Promise(r => setTimeout(r, 30));
    // Now probe succeeds
    queueOk();
    s.push({ x: 2 });
    await s.flush();
    assert.equal(s.circuitState, 'closed');
  });

  it('re-opens circuit on failure in half-open state', async () => {
    const s = makeSender({ failureThreshold: 1, recoveryMs: 10 });
    s.sessionId = 'sess-reopen';
    queueNetworkError();
    s.push({ x: 1 });
    await s.flush();
    assert.equal(s.circuitState, 'open');
    await new Promise(r => setTimeout(r, 30));
    // _canSend() transitions to half-open
    assert.ok(s._canSend());
    assert.equal(s._state, 'half-open');
    queueNetworkError();
    s.push({ x: 2 });
    await s.flush();
    assert.equal(s.circuitState, 'open');
    assert.equal(s.metrics.breakerTrips, 2);
  });

  it('re-queues batch on failure (events not lost)', async () => {
    const s = makeSender({ failureThreshold: 999 });
    s.sessionId = 'sess-requeue';
    queueNetworkError();
    s.push([{ v: 1 }, { v: 2 }]);
    await s.flush();
    assert.equal(s.bufferSize, 2); // events re-queued via _unshift
  });

  it('resets failure counter on success', async () => {
    const s = makeSender({ failureThreshold: 3 });
    s.sessionId = 'sess-reset';
    queueNetworkError();
    s.push({ x: 1 });
    await s.flush();
    assert.equal(s._consecutiveFailures, 1);
    queueOk();
    s.push({ x: 2 });
    await s.flush();
    assert.equal(s._consecutiveFailures, 0);
  });
});

// ── D9: sendWithRetry ───────────────────────

describe('sendWithRetry (D9)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('returns immediately on success', async () => {
    queueOk({ result: 'ok' });
    const s = makeSender({ maxRetries: 2 });
    const result = await s.sendWithRetry('/test', {});
    assert.deepEqual(result, { result: 'ok' });
    assert.equal(_fetchCalls.length, 1);
  });

  it('does NOT retry on 4xx (client error)', async () => {
    queueError(422, 'Unprocessable');
    const s = makeSender({ maxRetries: 3 });
    await assert.rejects(() => s.sendWithRetry('/test', {}));
    assert.equal(_fetchCalls.length, 1); // No retry
  });

  it('retries on 5xx up to maxRetries times', async () => {
    // 2 failures then success
    queueNetworkError();
    queueNetworkError();
    queueOk();
    const s = makeSender({ maxRetries: 2 });
    const result = await s.sendWithRetry('/test', {}, 2);
    assert.deepEqual(result, { success: true });
    assert.equal(s.metrics.retries, 2);
    assert.equal(_fetchCalls.length, 3);
  });

  it('throws after exhausting retries', async () => {
    queueNetworkError();
    queueNetworkError();
    const s = makeSender({ maxRetries: 1 });
    await assert.rejects(() => s.sendWithRetry('/test', {}, 1));
  });
});

// ── D8: drainOnUnload ───────────────────────

describe('drainOnUnload (D8)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('sends remaining events with keepalive:true', () => {
    const s = makeSender();
    s.sessionId = 'sess-unload';
    s.push([{ v: 1 }, { v: 2 }]);
    s.drainOnUnload();
    assert.equal(_fetchCalls.length, 1);
    assert.ok(_fetchCalls[0].keepalive);
    assert.ok(_fetchCalls[0].url.includes('/api/sessions/sess-unload/events'));
  });

  it('does nothing when buffer empty', () => {
    const s = makeSender();
    s.sessionId = 'sess-empty';
    s.drainOnUnload();
    assert.equal(_fetchCalls.length, 0);
  });

  it('does nothing when sessionId not set', () => {
    const s = makeSender();
    s.push({ x: 1 });
    s.drainOnUnload();
    assert.equal(_fetchCalls.length, 0);
  });

  it('falls back to sendBeacon when fetch throws on unload', () => {
    let beaconCalls = [];
    const origNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { sendBeacon: (url, blob) => { beaconCalls.push({ url, blob }); return true; } },
      configurable: true,
      writable: true,
    });
    // Make fetch throw synchronously
    globalThis.fetch = () => { throw new Error('keepalive not supported'); };
    const s = makeSender();
    s.sessionId = 'sess-beacon';
    s.push({ x: 1 });
    s.drainOnUnload();
    assert.equal(beaconCalls.length, 1);
    assert.ok(beaconCalls[0].url.includes('/api/sessions/sess-beacon/events'));
    if (origNavigator) Object.defineProperty(globalThis, 'navigator', origNavigator);
    else delete globalThis.navigator;
    restoreFetch();
    mockFetch();
  });
});

// ── D13: Lifecycle ──────────────────────────

describe('Lifecycle (D13)', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  it('destroy() sets _destroyed flag', () => {
    const s = makeSender();
    s.sessionId = 'sess-x';
    s.push({ x: 1 });
    s.destroy();
    assert.equal(s._destroyed, true);
  });

  it('destroy() stops auto-flush timer', () => {
    const s = makeSender({ flushInterval: 1000 });
    s.startAutoFlush();
    assert.ok(s._timer !== null);
    s.sessionId = 'sess-y';
    s.push({ x: 1 });
    s.destroy();
    assert.equal(s._timer, null);
  });

  it('startAutoFlush/stopAutoFlush manage timer correctly', () => {
    const s = makeSender({ flushInterval: 5000 });
    s.startAutoFlush();
    assert.ok(s._timer !== null);
    s.stopAutoFlush();
    assert.equal(s._timer, null);
  });

  it('stopAutoFlush is idempotent', () => {
    const s = makeSender();
    s.stopAutoFlush(); // no timer set — should not throw
    s.stopAutoFlush();
  });

  it('sessionId getter/setter work correctly', () => {
    const s = makeSender();
    assert.equal(s.sessionId, null);
    s.sessionId = 'abc-123';
    assert.equal(s.sessionId, 'abc-123');
  });
});
