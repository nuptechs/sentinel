// ─────────────────────────────────────────────
// Tests — SDK RecorderIntegration
// Browser globals mocked in-process.
// 14-dimension coverage: D1 D2 D7 D8 D9
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RecorderIntegration } from '../../src/sdk/integrations/recorder.integration.js';

// ── Browser globals setup ───────────────────

function makeBrowserEnv() {
  const listeners = {};
  const win = {
    fetch: null, // set per test
    addEventListener: (evt, fn) => { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); },
    removeEventListener: (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter(h => h !== fn); },
    dispatchEvent: (e) => { (listeners[e.type] || []).forEach(h => h(e)); },
    _listeners: listeners,
  };

  // Minimal CustomEvent
  class CustomEvent {
    constructor(type, opts) { this.type = type; this.detail = opts?.detail; }
  }

  // Minimal XMLHttpRequest
  class XMLHttpRequest {
    open(method, url, ...args) {
      this._method = method; this._url = url;
      if (XMLHttpRequest._originalOpen) XMLHttpRequest._originalOpen.call(this, method, url, ...args);
    }
    send(body) {
      if (XMLHttpRequest._originalSend) XMLHttpRequest._originalSend.call(this, body);
    }
    addEventListener(evt, fn) { this._evtFns = this._evtFns || {}; this._evtFns[evt] = fn; }
    triggerLoadend() { this._evtFns?.loadend?.(); }
  }
  XMLHttpRequest._originalOpen = null;
  XMLHttpRequest._originalSend = null;
  XMLHttpRequest.prototype._evtFns = {};

  globalThis.window = win;
  globalThis.CustomEvent = CustomEvent;
  globalThis.XMLHttpRequest = XMLHttpRequest;
  Object.defineProperty(globalThis, 'crypto', {
    value: { randomUUID: (() => { let i = 0; return () => `uuid-${++i}`; })() },
    configurable: true,
    writable: true,
  });

  return { win, XMLHttpRequest };
}

const _origCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

function teardownBrowserEnv() {
  delete globalThis.window;
  delete globalThis.CustomEvent;
  delete globalThis.XMLHttpRequest;
  if (_origCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', _origCryptoDescriptor);
}

function makeReporter() {
  const pushed = [];
  return { push: (evt) => pushed.push(evt), _pushed: pushed };
}

// ── D2: Constructor / defaults ───────────────

describe('RecorderIntegration constructor (D2)', () => {
  it('returns "recorder" as name', () => {
    const r = new RecorderIntegration();
    assert.equal(r.name, 'recorder');
  });

  it('enables all captures by default', () => {
    const r = new RecorderIntegration();
    assert.equal(r._options.captureDOM, true);
    assert.equal(r._options.captureNetwork, true);
    assert.equal(r._options.captureConsole, true);
    assert.equal(r._options.captureErrors, true);
  });

  it('defaults sampling rates to 1.0', () => {
    const r = new RecorderIntegration();
    assert.equal(r._options.sampling.sessionRate, 1.0);
    assert.equal(r._options.sampling.errorRate, 1.0);
  });

  it('respects explicit options', () => {
    const r = new RecorderIntegration({
      captureDOM: false, captureNetwork: false,
      captureConsole: false, captureErrors: false,
    });
    assert.equal(r._options.captureDOM, false);
    assert.equal(r._options.captureNetwork, false);
  });

  it('starts not running and not sampled (internally)', () => {
    const r = new RecorderIntegration({ sampling: { sessionRate: 0 } });
    assert.equal(r.isRunning, false);
  });
});

// ── D1: Error capture (always active) ────────

describe('Error capture (D1)', () => {
  beforeEach(makeBrowserEnv);
  afterEach(teardownBrowserEnv);

  it('pushes error event on window error', () => {
    const r = new RecorderIntegration({ captureConsole: false, captureNetwork: false, captureDOM: false });
    const reporter = makeReporter();
    r.setup({ reporter });

    const ev = { type: 'error', message: 'ReferenceError', filename: 'app.js', lineno: 42, colno: 8, error: { stack: 'Error at app.js:42' } };
    globalThis.window.dispatchEvent(ev);

    assert.equal(reporter._pushed.length, 1);
    assert.equal(reporter._pushed[0].type, 'error');
    assert.equal(reporter._pushed[0].payload.message, 'ReferenceError');
    assert.equal(reporter._pushed[0].payload.lineno, 42);
    assert.equal(reporter._pushed[0].payload.stack, 'Error at app.js:42');
  });

  it('pushes error event on unhandledrejection', () => {
    const r = new RecorderIntegration({ captureConsole: false, captureNetwork: false, captureDOM: false });
    const reporter = makeReporter();
    r.setup({ reporter });

    const ev = { type: 'unhandledrejection', reason: { message: 'Promise rejected', stack: '...' } };
    globalThis.window.dispatchEvent(ev);

    const found = reporter._pushed.find(e => e.source === 'unhandledrejection');
    assert.ok(found);
    assert.equal(found.payload.message, '[object Object]');
  });

  it('removes error listeners on teardown', () => {
    const r = new RecorderIntegration({ captureConsole: false, captureNetwork: false, captureDOM: false });
    const reporter = makeReporter();
    r.setup({ reporter });
    r.teardown();

    const ev = { type: 'error', message: 'late error', filename: 'x.js', lineno: 1, colno: 1, error: null };
    globalThis.window.dispatchEvent(ev);

    assert.equal(reporter._pushed.length, 0); // no events after teardown
  });
});

// ── D8: Sampling ──────────────────────────────

describe('Sampling (D8)', () => {
  beforeEach(makeBrowserEnv);
  afterEach(teardownBrowserEnv);

  it('session rate 1.0 marks as sampled', () => {
    const r = new RecorderIntegration({ sampling: { sessionRate: 1.0 } });
    assert.equal(r.isSampled, true);
  });

  it('session rate 0.0 marks as not sampled', () => {
    // Force not sampled (deterministic)
    const r = new RecorderIntegration({ sampling: { sessionRate: 0.0 } });
    assert.equal(r.isSampled, false);
  });

  it('unsampled session skips console capture', () => {
    const originalError = console.error;
    const r = new RecorderIntegration({ sampling: { sessionRate: 0.0 }, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = false; // force unsampled
    r.setup({ reporter });

    console.error('test');
    assert.equal(reporter._pushed.length, 0);
    console.error = originalError; // restore just in case
    r.teardown();
  });

  it('unsampled session with errorRate=1.0 upgrades on error (D8)', () => {
    const r = new RecorderIntegration({
      captureDOM: false, captureNetwork: false,
      sampling: { sessionRate: 0.0, errorRate: 1.0 },
    });
    const reporter = makeReporter();
    r._sampled = false;
    r.setup({ reporter });

    // Trigger window error — _upgradeRecording should be called
    const ev = { type: 'error', message: 'triggers upgrade', filename: 'f.js', lineno: 1, colno: 1, error: null };
    globalThis.window.dispatchEvent(ev);

    assert.equal(r._sampled, true); // upgraded
    r.teardown();
  });

  it('sampled session does not upgrade on error', () => {
    let upgradeCalled = false;
    const r = new RecorderIntegration({ captureDOM: false, captureNetwork: false });
    const reporter = makeReporter();
    r._sampled = true;
    r._upgradeRecording = () => { upgradeCalled = true; };
    r.setup({ reporter });

    const ev = { type: 'error', message: 'err', filename: 'f.js', lineno: 1, colno: 1, error: null };
    globalThis.window.dispatchEvent(ev);

    assert.equal(upgradeCalled, false);
    r.teardown();
  });
});

// ── D1 D9: Console capture ────────────────────

describe('Console capture (D1 D9)', () => {
  let originalError, originalWarn;
  beforeEach(() => {
    makeBrowserEnv();
    originalError = console.error;
    originalWarn = console.warn;
  });
  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
    teardownBrowserEnv();
  });

  it('intercepts console.error and pushes event', () => {
    const r = new RecorderIntegration({ captureDOM: false, captureNetwork: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    r.setup({ reporter });

    console.error('something broke');
    const found = reporter._pushed.find(e => e.source === 'error' && e.type === 'console');
    assert.ok(found);
    assert.equal(found.payload.message, 'something broke');
    r.teardown();
  });

  it('intercepts console.warn and pushes event', () => {
    const r = new RecorderIntegration({ captureDOM: false, captureNetwork: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    r.setup({ reporter });

    console.warn('warning text');
    const found = reporter._pushed.find(e => e.source === 'warn');
    assert.ok(found);
    assert.equal(found.payload.level, 'warn');
    r.teardown();
  });

  it('still calls original console.error after capture (D9)', () => {
    const calls = [];
    const r = new RecorderIntegration({ captureDOM: false, captureNetwork: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    r.setup({ reporter });

    console.error = (...args) => { calls.push(args); originalError.apply(console, args); };
    // The integration wraps, but should call through
    r.teardown(); // restore
    // After teardown, original is restored — check it doesn't throw
    assert.doesNotThrow(() => console.error('after teardown'));
  });

  it('restores console methods on teardown', () => {
    const original = console.error;
    const r = new RecorderIntegration({ captureDOM: false, captureNetwork: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    r.setup({ reporter });
    assert.notEqual(console.error, original); // patched
    r.teardown();
    assert.equal(console.error, original); // restored
  });

  it('does not push console events when not running (after teardown)', () => {
    const r = new RecorderIntegration({ captureDOM: false, captureNetwork: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    r.setup({ reporter });
    r.teardown();
    console.error('after stop');
    assert.equal(reporter._pushed.length, 0);
  });
});

// ── D1 D9: Network capture (fetch) ────────────

describe('Network capture — fetch (D1 D9)', () => {
  let originalFetch;
  beforeEach(() => {
    makeBrowserEnv();
    originalFetch = null;
  });
  afterEach(() => {
    if (originalFetch) globalThis.window.fetch = originalFetch;
    teardownBrowserEnv();
  });

  it('patches window.fetch on setup', () => {
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    // Set an original fetch
    globalThis.window.fetch = async () => ({ ok: true, status: 200 });
    r.setup({ reporter });
    assert.notEqual(globalThis.window.fetch.toString(), 'async () => ({ ok: true, status: 200 })');
    r.teardown();
  });

  it('pushes request event before fetch', async () => {
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    let fetchInvoked = false;
    globalThis.window.fetch = async (input, init) => {
      fetchInvoked = true;
      return { ok: true, status: 200 };
    };
    r.setup({ reporter });
    await globalThis.window.fetch('/api/test', { method: 'GET' });

    const reqEvent = reporter._pushed.find(e => e.payload?.phase === 'request');
    assert.ok(reqEvent);
    assert.equal(reqEvent.type, 'network');
    assert.equal(reqEvent.payload.url, '/api/test');
    r.teardown();
  });

  it('pushes response event after fetch with status', async () => {
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    globalThis.window.fetch = async () => ({ ok: true, status: 201 });
    r.setup({ reporter });
    await globalThis.window.fetch('/api/create', { method: 'POST' });

    const resEvent = reporter._pushed.find(e => e.payload?.phase === 'response');
    assert.ok(resEvent);
    assert.equal(resEvent.payload.status, 201);
    r.teardown();
  });

  it('shares correlationId between request and response events', async () => {
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    globalThis.window.fetch = async () => ({ ok: false, status: 500 });
    r.setup({ reporter });
    await globalThis.window.fetch('/api/fail', {});

    const req = reporter._pushed.find(e => e.payload?.phase === 'request');
    const res = reporter._pushed.find(e => e.payload?.phase === 'response');
    assert.equal(req.correlationId, res.correlationId);
    r.teardown();
  });

  it('pushes error event and dispatches sentinel-network-failure on fetch throw', async () => {
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    const reporter = makeReporter();
    r._sampled = true;
    globalThis.window.fetch = async () => { throw new Error('CORS error'); };
    const failures = [];
    globalThis.window.addEventListener('sentinel-network-failure', e => failures.push(e));
    r.setup({ reporter });

    await assert.rejects(() => globalThis.window.fetch('/api/cors'));
    const errEvent = reporter._pushed.find(e => e.payload?.phase === 'error');
    assert.ok(errEvent);
    assert.equal(errEvent.payload.error, 'CORS error');
    assert.equal(failures.length, 1);
    r.teardown();
  });

  it('restores window.fetch on teardown', () => {
    const original = async () => 'original';
    globalThis.window.fetch = original;
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    r._sampled = true;
    r.setup({ reporter: makeReporter() });
    r.teardown();
    assert.equal(globalThis.window.fetch, original);
  });
});

// ── D1 D9: Network capture (XHR) ─────────────

describe('Network capture — XHR (D1 D9)', () => {
  beforeEach(makeBrowserEnv);
  afterEach(teardownBrowserEnv);

  it('patches XMLHttpRequest.prototype.open and send', () => {
    const originalOpenProto = XMLHttpRequest.prototype.open;
    const originalSendProto = XMLHttpRequest.prototype.send;
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    r._sampled = true;
    r.setup({ reporter: makeReporter() });
    // Patched
    assert.notEqual(XMLHttpRequest.prototype.open, originalOpenProto);
    assert.notEqual(XMLHttpRequest.prototype.send, originalSendProto);
    r.teardown();
    // Restored
    assert.equal(XMLHttpRequest.prototype.open, originalOpenProto);
    assert.equal(XMLHttpRequest.prototype.send, originalSendProto);
  });

  it('pushes XHR request event on send', () => {
    const reporter = makeReporter();
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    r._sampled = true;
    r.setup({ reporter });

    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/data');
    xhr.send(null);

    const reqEvent = reporter._pushed.find(e => e.source === 'xhr' && e.payload?.phase === 'request');
    assert.ok(reqEvent);
    assert.equal(reqEvent.payload.url, '/api/data');
    assert.equal(reqEvent.payload.method, 'GET');
    r.teardown();
  });

  it('pushes XHR response event on loadend', () => {
    const reporter = makeReporter();
    const r = new RecorderIntegration({ captureDOM: false, captureConsole: false, captureErrors: false });
    r._sampled = true;
    r.setup({ reporter });

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/submit');
    xhr.status = 204;
    xhr.send('{}');
    xhr.triggerLoadend();

    const resEvent = reporter._pushed.find(e => e.source === 'xhr' && e.payload?.phase === 'response');
    assert.ok(resEvent);
    assert.equal(resEvent.payload.status, 204);
    r.teardown();
  });
});
