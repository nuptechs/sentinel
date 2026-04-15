// ─────────────────────────────────────────────
// Sentinel SDK — Recorder Integration
// DOM, network, console, and error capture.
// Modular integration wrapping the Recorder class.
// ─────────────────────────────────────────────

import { Integration } from '../core/integration.js';

export class RecorderIntegration extends Integration {
  constructor(opts = {}) {
    super();
    this._options = {
      captureDOM: opts.captureDOM ?? true,
      captureNetwork: opts.captureNetwork ?? true,
      captureConsole: opts.captureConsole ?? true,
      captureErrors: opts.captureErrors ?? true,
      sampling: {
        sessionRate: opts.sampling?.sessionRate ?? 1.0,
        errorRate: opts.sampling?.errorRate ?? 1.0,
      },
    };
    this._teardowns = [];
    this._running = false;
    this._rrwebStop = null;
    this._sampled = Math.random() < this._options.sampling.sessionRate;
    this._reporter = null;
  }

  get name() { return 'recorder'; }
  get isRunning() { return this._running; }
  get isSampled() { return this._sampled; }

  setup({ reporter }) {
    this._reporter = reporter;
    this._running = true;

    // Always capture errors (for sampling upgrade)
    if (this._options.captureErrors) this._captureErrors();

    // Skip non-error capture if not sampled
    if (!this._sampled) return;

    if (this._options.captureConsole) this._captureConsole();
    if (this._options.captureNetwork) this._captureNetwork();
    if (this._options.captureDOM) this._captureDOM();
  }

  teardown() {
    this._running = false;
    if (this._rrwebStop) {
      this._rrwebStop();
      this._rrwebStop = null;
    }
    for (const fn of this._teardowns) fn();
    this._teardowns = [];
  }

  _upgradeRecording() {
    if (this._options.captureConsole) this._captureConsole();
    if (this._options.captureNetwork) this._captureNetwork();
    if (this._options.captureDOM) this._captureDOM();
  }

  // ── DOM Recording (rrweb) ─────────────────

  async _captureDOM() {
    try {
      const rrweb = await import('rrweb');
      const record = rrweb.record || rrweb.default?.record;
      if (!record) return;

      this._rrwebStop = record({
        emit: (event) => {
          if (!this._running) return;
          this._reporter.push({
            type: 'dom',
            source: 'rrweb',
            timestamp: event.timestamp || Date.now(),
            payload: event,
          });
        },
        recordCanvas: false,
        collectFonts: false,
        blockSelector: '[data-sentinel-block]',
        maskInputSelector: '[data-sentinel-mask]',
      });
    } catch {
      // rrweb not available — DOM capture disabled
    }
  }

  // ── Network Interception ──────────────────

  _captureNetwork() {
    const reporter = this._reporter;

    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method || 'GET';
      const start = Date.now();
      const correlationId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      reporter.push({
        type: 'network', source: 'fetch', timestamp: start, correlationId,
        payload: { phase: 'request', url, method },
      });

      try {
        const res = await originalFetch(input, init);
        reporter.push({
          type: 'network', source: 'fetch', timestamp: Date.now(), correlationId,
          payload: { phase: 'response', url, method, status: res.status, duration: Date.now() - start },
        });
        return res;
      } catch (err) {
        const failurePayload = { phase: 'error', url, method, error: err.message, duration: Date.now() - start };
        reporter.push({
          type: 'network', source: 'fetch', timestamp: Date.now(), correlationId,
          payload: failurePayload,
        });
        window.dispatchEvent(new CustomEvent('sentinel-network-failure', { detail: { type: 'network', payload: failurePayload } }));
        throw err;
      }
    };
    this._teardowns.push(() => { window.fetch = originalFetch; });

    // Intercept XMLHttpRequest
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this._sentinel = { method, url, correlationId: crypto.randomUUID?.() || `${Date.now()}` };
      return originalOpen.call(this, method, url, ...args);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (this._sentinel) {
        const start = Date.now();
        reporter.push({
          type: 'network', source: 'xhr', timestamp: start, correlationId: this._sentinel.correlationId,
          payload: { phase: 'request', url: this._sentinel.url, method: this._sentinel.method },
        });

        this.addEventListener('loadend', () => {
          reporter.push({
            type: 'network', source: 'xhr', timestamp: Date.now(), correlationId: this._sentinel.correlationId,
            payload: {
              phase: 'response', url: this._sentinel.url, method: this._sentinel.method,
              status: this.status, duration: Date.now() - start,
            },
          });
        });
      }
      return originalSend.call(this, body);
    };

    this._teardowns.push(() => {
      XMLHttpRequest.prototype.open = originalOpen;
      XMLHttpRequest.prototype.send = originalSend;
    });
  }

  // ── Console Capture ───────────────────────

  _captureConsole() {
    const levels = ['error', 'warn'];
    const originals = {};

    for (const level of levels) {
      originals[level] = console[level];
      console[level] = (...args) => {
        if (this._running) {
          this._reporter.push({
            type: 'console', source: level, timestamp: Date.now(),
            payload: { level, message: args.map(a => String(a)).join(' ') },
          });
        }
        originals[level].apply(console, args);
      };
    }

    this._teardowns.push(() => {
      for (const level of levels) console[level] = originals[level];
    });
  }

  // ── Error Capture ─────────────────────────

  _captureErrors() {
    const onError = (event) => {
      this._reporter.push({
        type: 'error', source: 'window', timestamp: Date.now(),
        payload: {
          message: event.message, filename: event.filename,
          lineno: event.lineno, colno: event.colno, stack: event.error?.stack,
        },
      });
      if (!this._sampled && Math.random() < this._options.sampling.errorRate) {
        this._sampled = true;
        this._upgradeRecording();
      }
    };

    const onRejection = (event) => {
      this._reporter.push({
        type: 'error', source: 'unhandledrejection', timestamp: Date.now(),
        payload: { message: String(event.reason), stack: event.reason?.stack },
      });
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    this._teardowns.push(() => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    });
  }
}
