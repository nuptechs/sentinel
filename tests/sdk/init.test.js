// ─────────────────────────────────────────────
// Tests — SDK init() (SentinelSDK entry point)
// Tests the integration orchestration, instance
// API, lifecycle, and legacy option handling.
// 14-dimension coverage: D1 D2 D6 D7 D8 D9 D13
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { init, Integration } from '../../src/sdk/index.js';

// ── Fetch mock ──────────────────────────────

let _fetchCalls = [];
let _fetchQueue = [];
const _origFetch = globalThis.fetch;

function mockFetch() {
  _fetchCalls = [];
  _fetchQueue = [];
  globalThis.fetch = async (url, opts = {}) => {
    _fetchCalls.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
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

function restoreFetch() { globalThis.fetch = _origFetch; }

function queueOk(json = { success: true }) {
  _fetchQueue.push({ ok: true, status: 200, json });
}

// ── Browser globals ─────────────────────────

let _saved = {};

function setupBrowser() {
  _saved.nav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  _saved.loc = Object.getOwnPropertyDescriptor(globalThis, 'location');
  _saved.win = globalThis.window;

  const listeners = {};
  const win = {
    addEventListener: (evt, fn) => { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); },
    removeEventListener: (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(h => h !== fn); },
    _listeners: listeners,
  };
  globalThis.window = win;
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Test/1.0' },
    configurable: true, writable: true,
  });
  Object.defineProperty(globalThis, 'location', {
    value: { href: 'http://test.local/' },
    configurable: true, writable: true,
  });
}

function teardownBrowser() {
  if (_saved.nav) Object.defineProperty(globalThis, 'navigator', _saved.nav);
  else delete globalThis.navigator;
  if (_saved.loc) Object.defineProperty(globalThis, 'location', _saved.loc);
  else delete globalThis.location;
  if (_saved.win !== undefined) globalThis.window = _saved.win;
  else delete globalThis.window;
  _saved = {};
}

// ── Stub integration ────────────────────────

class StubIntegration extends Integration {
  constructor(n = 'stub') { super(); this._name = n; this.setupCalled = false; this.teardownCalled = false; this._ctx = null; }
  get name() { return this._name; }
  setup(ctx) { this.setupCalled = true; this._ctx = ctx; }
  teardown() { this.teardownCalled = true; }
}

class AsyncStubIntegration extends Integration {
  constructor() { super(); this._name = 'async-stub'; this.setupCalled = false; }
  get name() { return this._name; }
  async setup(ctx) { await new Promise(r => setTimeout(r, 5)); this.setupCalled = true; }
  teardown() {}
}

class FailingIntegration extends Integration {
  constructor() { super(); this._name = 'failing'; }
  get name() { return this._name; }
  setup() { throw new Error('boom'); }
  teardown() {}
}

// ── D2: Validation ──────────────────────────

describe('init() validation (D2)', () => {
  it('throws when serverUrl is missing', async () => {
    await assert.rejects(() => init({ projectId: 'p' }), /serverUrl is required/);
  });

  it('throws when projectId is missing', async () => {
    await assert.rejects(() => init({ serverUrl: 'http://x' }), /projectId is required/);
  });
});

// ── D1: Happy path ──────────────────────────

describe('init() happy path (D1)', () => {
  beforeEach(() => { mockFetch(); setupBrowser(); });
  afterEach(() => { restoreFetch(); teardownBrowser(); });

  it('creates session, sets up integrations, returns instance', async () => {
    queueOk({ data: { id: 'sess-init' } }); // startSession
    const stub = new StubIntegration();

    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      userId: 'dev@test',
      apiKey: 'sk-x',
      integrations: [stub],
    });

    // Session created
    assert.equal(instance.session.id, 'sess-init');
    assert.ok(instance.reporter);
    assert.ok(instance.shadowHost);

    // Integration was called
    assert.ok(stub.setupCalled);
    assert.ok(stub._ctx.reporter);
    assert.ok(stub._ctx.shadowHost);
    assert.equal(stub._ctx.options.projectId, 'proj-1');

    // Clean up
    queueOk(); // flush
    queueOk(); // complete
    await instance.stop();
  });

  it('handles async integration setup', async () => {
    queueOk({ data: { id: 'sess-async' } });
    const asyncStub = new AsyncStubIntegration();

    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      integrations: [asyncStub],
    });

    assert.ok(asyncStub.setupCalled);

    queueOk(); queueOk();
    await instance.stop();
  });

  it('gracefully handles failing integration (D6)', async () => {
    queueOk({ data: { id: 'sess-fail' } });
    const good = new StubIntegration('good');
    const bad = new FailingIntegration();

    // Should NOT throw — logs a warning instead
    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      integrations: [bad, good],
    });

    // Good integration still got set up
    assert.ok(good.setupCalled);

    queueOk(); queueOk();
    await instance.stop();
  });
});

// ── D8: Instance API ───────────────────────

describe('SentinelInstance methods (D8)', () => {
  beforeEach(() => { mockFetch(); setupBrowser(); });
  afterEach(() => { restoreFetch(); teardownBrowser(); });

  it('getIntegration() finds by name', async () => {
    queueOk({ data: { id: 'sess-gi' } });
    const stub = new StubIntegration('my-plugin');

    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      integrations: [stub],
    });

    assert.equal(instance.getIntegration('my-plugin'), stub);
    assert.equal(instance.getIntegration('nonexistent'), null);

    queueOk(); queueOk();
    await instance.stop();
  });

  it('addIntegration() adds and sets up at runtime', async () => {
    queueOk({ data: { id: 'sess-add' } });

    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      integrations: [],
    });

    const late = new StubIntegration('late');
    instance.addIntegration(late);
    assert.ok(late.setupCalled);
    assert.ok(instance.getIntegration('late'));

    queueOk(); queueOk();
    await instance.stop();
  });

  it('report() delegates to reporter.reportFinding', async () => {
    queueOk({ data: { id: 'sess-report' } });
    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      integrations: [],
    });

    queueOk({ data: { id: 'finding-1' } });
    const finding = await instance.report({
      annotation: 'Test issue',
      browserContext: {},
      description: 'broken',
    });
    assert.equal(finding.id, 'finding-1');

    // Check defaults applied
    const call = _fetchCalls.find(c => c.url.includes('/api/findings'));
    const body = JSON.parse(call.body);
    assert.equal(body.source, 'programmatic');
    assert.equal(body.type, 'bug');
    assert.equal(body.severity, 'medium');

    queueOk(); queueOk();
    await instance.stop();
  });
});

// ── D13: stop lifecycle ─────────────────────

describe('SentinelInstance.stop (D13)', () => {
  beforeEach(() => { mockFetch(); setupBrowser(); });
  afterEach(() => { restoreFetch(); teardownBrowser(); });

  it('tears down integrations in reverse order', async () => {
    queueOk({ data: { id: 'sess-stop' } });
    const order = [];
    class TrackedIntegration extends Integration {
      constructor(n) { super(); this._name = n; }
      get name() { return this._name; }
      setup() {}
      teardown() { order.push(this._name); }
    }

    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      integrations: [new TrackedIntegration('first'), new TrackedIntegration('second'), new TrackedIntegration('third')],
    });

    queueOk(); // flush
    queueOk(); // complete
    await instance.stop();

    assert.deepEqual(order, ['third', 'second', 'first']);
  });

  it('removes beforeunload listener', async () => {
    queueOk({ data: { id: 'sess-unload' } });

    const instance = await init({
      serverUrl: 'http://sentinel:7070',
      projectId: 'proj-1',
      integrations: [],
    });

    assert.ok(globalThis.window._listeners['beforeunload']?.length > 0);

    queueOk(); queueOk();
    await instance.stop();

    assert.equal(globalThis.window._listeners['beforeunload']?.length, 0);
  });
});
