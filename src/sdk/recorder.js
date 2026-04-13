// ─────────────────────────────────────────────
// Sentinel SDK — DOM/Network/Console Recorder
// Uses rrweb for DOM recording + native APIs
// for network/console/error capture
// ─────────────────────────────────────────────

/**
 * Recorder captures browser events and pushes them to a Reporter.
 *
 * Event types:
 *   - dom: rrweb DOM mutations (requires rrweb as peer dep)
 *   - network: XHR/fetch requests and responses
 *   - console: console.error/warn calls
 *   - error: unhandled errors and promise rejections
 *   - interaction: click, input, scroll (via rrweb or custom)
 */
export class Recorder {
  constructor({ reporter, captureDOM = true, captureNetwork = true, captureConsole = true, captureErrors = true, sampling = {} } = {}) {
    if (!reporter) throw new Error('Recorder: reporter is required');

    this._reporter = reporter;
    this._options = { captureDOM, captureNetwork, captureConsole, captureErrors };
    this._sampling = {
      sessionRate: sampling.sessionRate ?? 1.0,    // 0.0–1.0: % of sessions recorded
      errorRate: sampling.errorRate ?? 1.0,         // 0.0–1.0: always record on error
    };
    this._teardowns = [];
    this._running = false;
    this._rrwebStop = null;
    this._sampled = Math.random() < this._sampling.sessionRate;
  }

  get isRunning() {
    return this._running;
  }

  get isSampled() {
    return this._sampled;
  }

  /**
   * Start recording. Call after reporter.startSession().
   */
  async start() {
    if (this._running) return;
    this._running = true;

    // Always capture errors (respects errorRate for full recording)
    if (this._options.captureErrors) this._captureErrors();

    // Skip non-error capture if session was not sampled
    if (!this._sampled) return;

    if (this._options.captureConsole) this._captureConsole();
    if (this._options.captureNetwork) this._captureNetwork();
    if (this._options.captureDOM) await this._captureDOM();
  }

  /**
   * Upgrade an unsampled session to full recording (triggered by error).
   */
  _upgradeRecording() {
    if (this._options.captureConsole) this._captureConsole();
    if (this._options.captureNetwork) this._captureNetwork();
    if (this._options.captureDOM) this._captureDOM();
  }

  /**
   * Stop recording and clean up all event listeners.
   */
  stop() {
    this._running = false;
    if (this._rrwebStop) {
      this._rrwebStop();
      this._rrwebStop = null;
    }
    for (const teardown of this._teardowns) {
      teardown();
    }
    this._teardowns = [];
  }

  // ── DOM Recording (rrweb) ─────────────────

  async _captureDOM() {
    try {
      const rrweb = await import('rrweb');
      const record = rrweb.record || rrweb.default?.record;
      if (!record) {
        console.warn('[Sentinel] rrweb.record not found — DOM capture disabled');
        return;
      }

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
        // Record mutations, mouse, scroll, input, media
        recordCanvas: false,
        collectFonts: false,
        blockSelector: '[data-sentinel-block]',
        maskInputSelector: '[data-sentinel-mask]',
      });
    } catch {
      console.warn('[Sentinel] rrweb not available — DOM capture disabled. Install: npm i rrweb');
    }
  }

  // ── Network Interception ──────────────────

  _captureNetwork() {
    // Intercept fetch
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const method = init?.method || 'GET';
      const start = Date.now();
      const correlationId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

      this._reporter.push({
        type: 'network',
        source: 'fetch',
        timestamp: start,
        correlationId,
        payload: { phase: 'request', url, method },
      });

      try {
        const res = await originalFetch(input, init);
        this._reporter.push({
          type: 'network',
          source: 'fetch',
          timestamp: Date.now(),
          correlationId,
          payload: { phase: 'response', url, method, status: res.status, duration: Date.now() - start },
        });
        return res;
      } catch (err) {
        const failurePayload = { phase: 'error', url, method, error: err.message, duration: Date.now() - start };
        this._reporter.push({
          type: 'network',
          source: 'fetch',
          timestamp: Date.now(),
          correlationId,
          payload: failurePayload,
        });
        window.dispatchEvent(new CustomEvent('sentinel-network-failure', { detail: { type: 'network', payload: failurePayload } }));
        throw err;
      }
    };

    this._teardowns.push(() => { window.fetch = originalFetch; });

    // Intercept XMLHttpRequest
    const originalXHROpen = XMLHttpRequest.prototype.open;
    const originalXHRSend = XMLHttpRequest.prototype.send;
    const reporter = this._reporter;

    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this._sentinel = { method, url, correlationId: crypto.randomUUID?.() || `${Date.now()}` };
      return originalXHROpen.call(this, method, url, ...args);
    };

    XMLHttpRequest.prototype.send = function (body) {
      if (this._sentinel) {
        const start = Date.now();
        reporter.push({
          type: 'network',
          source: 'xhr',
          timestamp: start,
          correlationId: this._sentinel.correlationId,
          payload: { phase: 'request', url: this._sentinel.url, method: this._sentinel.method },
        });

        this.addEventListener('loadend', () => {
          reporter.push({
            type: 'network',
            source: 'xhr',
            timestamp: Date.now(),
            correlationId: this._sentinel.correlationId,
            payload: {
              phase: 'response',
              url: this._sentinel.url,
              method: this._sentinel.method,
              status: this.status,
              duration: Date.now() - start,
            },
          });
        });
      }
      return originalXHRSend.call(this, body);
    };

    this._teardowns.push(() => {
      XMLHttpRequest.prototype.open = originalXHROpen;
      XMLHttpRequest.prototype.send = originalXHRSend;
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
            type: 'console',
            source: level,
            timestamp: Date.now(),
            payload: { level, message: args.map(a => String(a)).join(' ') },
          });
        }
        originals[level].apply(console, args);
      };
    }

    this._teardowns.push(() => {
      for (const level of levels) {
        console[level] = originals[level];
      }
    });
  }

  // ── Error Capture ─────────────────────────

  _captureErrors() {
    const onError = (event) => {
      this._reporter.push({
        type: 'error',
        source: 'window',
        timestamp: Date.now(),
        payload: {
          message: event.message,
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error?.stack,
        },
      });
      // Upgrade unsampled session to full recording on error
      if (!this._sampled && Math.random() < this._sampling.errorRate) {
        this._sampled = true;
        this._upgradeRecording();
      }
    };

    const onRejection = (event) => {
      this._reporter.push({
        type: 'error',
        source: 'unhandledrejection',
        timestamp: Date.now(),
        payload: {
          message: String(event.reason),
          stack: event.reason?.stack,
        },
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
