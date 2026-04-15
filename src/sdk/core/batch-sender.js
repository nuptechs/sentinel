// ─────────────────────────────────────────────
// Sentinel SDK — BatchSender
// Ring-buffer event transport with circuit breaker.
// Inspired by Debug Probe's BatchSender pattern.
//
// Features:
//   • Fixed-capacity ring buffer (prevents OOM on slow networks)
//   • Circuit breaker (stops hammering dead servers)
//   • Exponential backoff with jitter on retry
//   • fetch+keepalive on page unload, sendBeacon fallback
// ─────────────────────────────────────────────

const STATE_CLOSED = 'closed';      // healthy — requests flow
const STATE_OPEN = 'open';          // unhealthy — requests blocked
const STATE_HALF_OPEN = 'half-open'; // probing — single request allowed

export class BatchSender {
  /**
   * @param {object} opts
   * @param {string} opts.url           — the server URL (no trailing slash)
   * @param {string} [opts.apiKey]
   * @param {number} [opts.batchSize=50]
   * @param {number} [opts.flushInterval=3000]  — ms between auto-flushes
   * @param {number} [opts.maxBufferSize=10000] — ring buffer capacity
   * @param {number} [opts.failureThreshold=3]  — consecutive failures before opening breaker
   * @param {number} [opts.recoveryMs=30000]    — time before half-open retry
   * @param {number} [opts.maxRetries=3]
   */
  constructor({
    url,
    apiKey = null,
    batchSize = 50,
    flushInterval = 3000,
    maxBufferSize = 10_000,
    failureThreshold = 3,
    recoveryMs = 30_000,
    maxRetries = 3,
  } = {}) {
    if (!url) throw new Error('BatchSender: url is required');

    this._url = url.replace(/\/$/, '');
    this._apiKey = apiKey;
    this._batchSize = batchSize;
    this._flushInterval = flushInterval;
    this._maxRetries = maxRetries;

    // Ring buffer
    this._buffer = new Array(maxBufferSize);
    this._capacity = maxBufferSize;
    this._head = 0;   // write pointer
    this._tail = 0;   // read pointer
    this._size = 0;

    // Circuit breaker state
    this._state = STATE_CLOSED;
    this._consecutiveFailures = 0;
    this._failureThreshold = failureThreshold;
    this._recoveryMs = recoveryMs;
    this._lastFailureTime = 0;

    // Flush timer
    this._timer = null;
    this._flushing = false;
    this._sessionId = null;
    this._destroyed = false;

    // Metrics
    this.metrics = {
      sent: 0,
      dropped: 0,
      retries: 0,
      breakerTrips: 0,
    };
  }

  get sessionId() { return this._sessionId; }
  set sessionId(id) { this._sessionId = id; }

  get bufferSize() { return this._size; }
  get circuitState() { return this._state; }

  // ── Ring buffer operations ────────────────

  /**
   * Push events into the ring buffer. If full, oldest events are dropped.
   */
  push(events) {
    if (this._destroyed) return;
    const arr = Array.isArray(events) ? events : [events];

    for (const event of arr) {
      this._buffer[this._head] = event;
      this._head = (this._head + 1) % this._capacity;

      if (this._size < this._capacity) {
        this._size++;
      } else {
        // Buffer full — drop oldest by advancing tail
        this._tail = (this._tail + 1) % this._capacity;
        this.metrics.dropped++;
      }
    }

    if (this._size >= this._batchSize) {
      this.flush();
    }
  }

  /**
   * Drain up to `count` events from the buffer.
   */
  _drain(count) {
    const drained = [];
    const n = Math.min(count, this._size);
    for (let i = 0; i < n; i++) {
      drained.push(this._buffer[this._tail]);
      this._buffer[this._tail] = undefined; // help GC
      this._tail = (this._tail + 1) % this._capacity;
      this._size--;
    }
    return drained;
  }

  /**
   * Put events back at the front (for retry).
   * Only if there's room — otherwise drop them.
   */
  _unshift(events) {
    for (let i = events.length - 1; i >= 0; i--) {
      if (this._size >= this._capacity) {
        this.metrics.dropped++;
        continue;
      }
      this._tail = (this._tail - 1 + this._capacity) % this._capacity;
      this._buffer[this._tail] = events[i];
      this._size++;
    }
  }

  // ── Circuit breaker ───────────────────────

  _canSend() {
    if (this._state === STATE_CLOSED) return true;
    if (this._state === STATE_OPEN) {
      if (Date.now() - this._lastFailureTime >= this._recoveryMs) {
        this._state = STATE_HALF_OPEN;
        return true;
      }
      return false;
    }
    // half-open: allow one probe
    return true;
  }

  _onSuccess() {
    this._consecutiveFailures = 0;
    if (this._state !== STATE_CLOSED) {
      this._state = STATE_CLOSED;
    }
  }

  _onFailure() {
    this._consecutiveFailures++;
    this._lastFailureTime = Date.now();
    if (this._state === STATE_HALF_OPEN) {
      this._state = STATE_OPEN;
      this.metrics.breakerTrips++;
    } else if (this._consecutiveFailures >= this._failureThreshold) {
      this._state = STATE_OPEN;
      this.metrics.breakerTrips++;
    }
  }

  // ── Flush ─────────────────────────────────

  startAutoFlush() {
    this.stopAutoFlush();
    this._timer = setInterval(() => this.flush(), this._flushInterval);
  }

  stopAutoFlush() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async flush() {
    if (this._flushing || this._size === 0 || !this._sessionId || this._destroyed) return;
    if (!this._canSend()) return;

    this._flushing = true;
    const batch = this._drain(this._batchSize);

    try {
      await this._send(`/api/sessions/${this._sessionId}/events`, {
        method: 'POST',
        body: JSON.stringify({ events: batch }),
      });
      this._onSuccess();
      this.metrics.sent += batch.length;
    } catch (err) {
      this._onFailure();
      // Put events back for retry
      this._unshift(batch);
    } finally {
      this._flushing = false;
    }
  }

  // ── HTTP transport ────────────────────────

  _buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Sentinel-SDK': 'browser/2.0',
      ...extra,
    };
    if (this._apiKey) headers['X-Sentinel-Key'] = this._apiKey;
    return headers;
  }

  async _send(path, options = {}) {
    const headers = this._buildHeaders(options.headers);
    const url = `${this._url}${path}`;

    const res = await fetch(url, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.error?.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }

    return res.json();
  }

  /**
   * Send a request with retry + backoff.
   */
  async sendWithRetry(path, options = {}, retries = this._maxRetries) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this._send(path, options);
      } catch (err) {
        if (attempt === retries || (err.status >= 400 && err.status < 500)) {
          throw err;
        }
        this.metrics.retries++;
        // Exponential backoff with jitter
        const delay = Math.min(1000 * 2 ** attempt, 10_000) + Math.random() * 500;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // ── Page unload ───────────────────────────

  /**
   * Best-effort final flush on page unload.
   * Uses fetch+keepalive → sendBeacon fallback.
   */
  drainOnUnload() {
    if (this._size === 0 || !this._sessionId) return;

    const events = this._drain(this._size);
    const body = JSON.stringify({ events });
    const url = `${this._url}/api/sessions/${this._sessionId}/events`;
    const headers = this._buildHeaders();

    try {
      fetch(url, { method: 'POST', headers, body, keepalive: true });
    } catch {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      }
    }
  }

  // ── Lifecycle ─────────────────────────────

  destroy() {
    this._destroyed = true;
    this.stopAutoFlush();
    this.drainOnUnload();
  }
}
