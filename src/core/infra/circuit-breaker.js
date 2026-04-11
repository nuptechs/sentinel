// ─────────────────────────────────────────────
// Sentinel — Circuit Breaker
//
// Protects against cascading failures when calling
// external services (Manifest API, Debug Probe API,
// Claude AI, issue trackers, webhooks).
//
// Three states:
//   CLOSED   — Normal operation. Failures are counted.
//   OPEN     — Requests are rejected immediately.
//              After `recoveryMs`, transitions to HALF_OPEN.
//   HALF_OPEN— A single probe request is allowed through.
//              Success → CLOSED. Failure → OPEN again.
//
// This implementation uses a sliding window of recent
// calls (not a simple counter) to avoid resetting on
// clock boundaries. This matches the approach in
// Resilience4j (Java), Polly (.NET), and Debug Probe's
// own PostgreSQL storage adapter.
//
// ─────────────────────────────────────────────

/**
 * @typedef {'CLOSED'|'OPEN'|'HALF_OPEN'} CircuitState
 */

/**
 * @typedef {object} CircuitBreakerOptions
 * @property {string}  [name='unnamed']       — identifies this breaker in logs
 * @property {number}  [failureThreshold=5]   — failures in window to trip OPEN
 * @property {number}  [windowMs=60000]       — sliding window for failure counting (ms)
 * @property {number}  [recoveryMs=30000]     — how long OPEN stays before HALF_OPEN (ms)
 * @property {number}  [halfOpenMax=1]        — concurrent probes in HALF_OPEN
 * @property {number}  [timeoutMs=0]          — per-call timeout (0 = no timeout)
 * @property {function} [onStateChange]       — callback(from, to, breaker)
 * @property {function} [isFailure]           — predicate(error) → boolean
 */

export class CircuitBreaker {
  /**
   * @param {CircuitBreakerOptions} options
   */
  constructor({
    name = 'unnamed',
    failureThreshold = 5,
    windowMs = 60_000,
    recoveryMs = 30_000,
    halfOpenMax = 1,
    timeoutMs = 0,
    onStateChange = null,
    isFailure = null,
  } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.windowMs = windowMs;
    this.recoveryMs = recoveryMs;
    this.halfOpenMax = halfOpenMax;
    this.timeoutMs = timeoutMs;
    this.onStateChange = onStateChange;
    this.isFailure = isFailure ?? (() => true); // by default every error is a failure

    /** @type {CircuitState} */
    this.state = 'CLOSED';

    // Sliding window: timestamps of recent failures
    this._failures = [];

    // When the circuit tripped to OPEN
    this._openedAt = 0;

    // Active probe count in HALF_OPEN
    this._halfOpenActive = 0;

    // Counters for observability
    this.metrics = {
      totalCalls: 0,
      totalSuccess: 0,
      totalFailure: 0,
      totalRejected: 0,
      totalTimeout: 0,
      lastFailureAt: null,
      lastSuccessAt: null,
    };
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * @template T
   * @param {() => Promise<T>} fn — the async operation to protect
   * @param {T} [fallback] — optional fallback value when circuit is OPEN
   * @returns {Promise<T>}
   * @throws {CircuitOpenError} if circuit is OPEN and no fallback provided
   */
  async fire(fn, fallback) {
    this.metrics.totalCalls++;

    // Check state transitions
    this._maybeTransition();

    if (this.state === 'OPEN') {
      this.metrics.totalRejected++;
      if (fallback !== undefined) return fallback;
      throw new CircuitOpenError(this.name, this._timeUntilHalfOpen());
    }

    if (this.state === 'HALF_OPEN' && this._halfOpenActive >= this.halfOpenMax) {
      this.metrics.totalRejected++;
      if (fallback !== undefined) return fallback;
      throw new CircuitOpenError(this.name, this._timeUntilHalfOpen());
    }

    if (this.state === 'HALF_OPEN') {
      this._halfOpenActive++;
    }

    try {
      const result = this.timeoutMs > 0
        ? await this._withTimeout(fn, this.timeoutMs)
        : await fn();

      this._onSuccess();
      return result;
    } catch (err) {
      if (err instanceof TimeoutError) {
        this.metrics.totalTimeout++;
      }

      if (this.isFailure(err)) {
        this._onFailure();
      } else {
        // Error is not considered a circuit-relevant failure
        // (e.g., 4xx client errors shouldn't trip the breaker)
        this._onSuccess();
      }

      throw err;
    }
  }

  /**
   * Manually reset the circuit to CLOSED.
   */
  reset() {
    this._transition('CLOSED');
    this._failures = [];
    this._halfOpenActive = 0;
  }

  /**
   * Get current state info for health checks.
   */
  getStatus() {
    this._maybeTransition();
    return {
      name: this.name,
      state: this.state,
      failures: this._recentFailureCount(),
      threshold: this.failureThreshold,
      metrics: { ...this.metrics },
    };
  }

  // ── Internal state machine ────────────────

  _onSuccess() {
    this.metrics.totalSuccess++;
    this.metrics.lastSuccessAt = Date.now();

    if (this.state === 'HALF_OPEN') {
      this._halfOpenActive--;
      this._transition('CLOSED');
      this._failures = [];
    }
  }

  _onFailure() {
    const now = Date.now();
    this.metrics.totalFailure++;
    this.metrics.lastFailureAt = now;
    this._failures.push(now);

    if (this.state === 'HALF_OPEN') {
      this._halfOpenActive--;
      this._transition('OPEN');
      return;
    }

    // CLOSED: check if threshold exceeded in window
    if (this.state === 'CLOSED' && this._recentFailureCount() >= this.failureThreshold) {
      this._transition('OPEN');
    }
  }

  _maybeTransition() {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this._openedAt;
      if (elapsed >= this.recoveryMs) {
        this._transition('HALF_OPEN');
      }
    }
  }

  _transition(newState) {
    if (this.state === newState) return;
    const from = this.state;
    this.state = newState;

    if (newState === 'OPEN') {
      this._openedAt = Date.now();
    }

    if (this.onStateChange) {
      try { this.onStateChange(from, newState, this); } catch { /* observer error must not break flow */ }
    }

    console.log(`[CircuitBreaker:${this.name}] ${from} → ${newState}`);
  }

  /**
   * Count failures within the sliding window.
   * Also prunes expired entries.
   */
  _recentFailureCount() {
    const cutoff = Date.now() - this.windowMs;
    this._failures = this._failures.filter(ts => ts > cutoff);
    return this._failures.length;
  }

  _timeUntilHalfOpen() {
    if (this.state !== 'OPEN') return 0;
    return Math.max(0, this.recoveryMs - (Date.now() - this._openedAt));
  }

  /**
   * Wrap a promise with a timeout.
   */
  async _withTimeout(fn, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new TimeoutError(this.name, ms));
      }, ms);

      fn().then(
        (val) => { clearTimeout(timer); resolve(val); },
        (err) => { clearTimeout(timer); reject(err); },
      );
    });
  }
}

// ── Error classes ─────────────────────────────

export class CircuitOpenError extends Error {
  constructor(name, retryAfterMs) {
    super(`Circuit breaker "${name}" is OPEN — rejecting call (retry in ${Math.ceil(retryAfterMs / 1000)}s)`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
    this.isCircuitOpen = true;
  }
}

export class TimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(`Circuit breaker "${name}" call timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}
