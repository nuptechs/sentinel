// ─────────────────────────────────────────────
// Sentinel SDK — Event Reporter
// Sends captured events to the Sentinel server.
// Uses BatchSender (ring buffer + circuit breaker) internally.
// ─────────────────────────────────────────────

import { BatchSender } from './core/batch-sender.js';

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_INTERVAL = 3000;
const DEFAULT_BUFFER_CAPACITY = 10000;

export class Reporter {
  constructor({ serverUrl, projectId, sessionId = null, apiKey = null, batchSize, flushInterval, bufferCapacity } = {}) {
    if (!serverUrl) throw new Error('Reporter: serverUrl is required');
    if (!projectId) throw new Error('Reporter: projectId is required');

    this._serverUrl = serverUrl.replace(/\/$/, '');
    this._projectId = projectId;
    this._sessionId = sessionId;
    this._apiKey = apiKey;
    this._batchSize = batchSize || DEFAULT_BATCH_SIZE;
    this._flushInterval = flushInterval || DEFAULT_FLUSH_INTERVAL;

    // BatchSender handles the ring buffer, circuit breaker, and transport
    this._sender = new BatchSender({
      endpoint: '', // Set dynamically once sessionId is known
      apiKey: this._apiKey,
      batchSize: this._batchSize,
      flushMs: this._flushInterval,
      capacity: bufferCapacity || DEFAULT_BUFFER_CAPACITY,
      autoFlush: false, // We control the flush timer ourselves
    });
  }

  get sessionId() {
    return this._sessionId;
  }

  /** BatchSender metrics (sent, dropped, retries, breakerTrips) */
  get metrics() {
    return this._sender.metrics;
  }

  /**
   * Start a new QA session on the server.
   */
  async startSession({ userId, metadata } = {}) {
    const res = await this._fetch('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        projectId: this._projectId,
        userId: userId || 'anonymous',
        userAgent: navigator.userAgent,
        pageUrl: location.href,
        metadata,
      }),
    });

    this._sessionId = res.data.id;
    // Point BatchSender at the session events endpoint
    this._sender._endpoint = `${this._serverUrl}/api/sessions/${this._sessionId}/events`;
    this._startFlushTimer();
    return res.data;
  }

  /**
   * Queue events for batched sending via ring buffer.
   */
  push(events) {
    const arr = Array.isArray(events) ? events : [events];
    for (const evt of arr) {
      this._sender.push(evt);
    }

    if (this._sender._count >= this._batchSize) {
      this.flush();
    }
  }

  /**
   * Flush buffered events to the server.
   */
  async flush() {
    if (!this._sessionId) return;
    await this._sender.flush();
  }

  /**
   * Submit a finding (annotation) to the server.
   */
  async reportFinding({ annotation, browserContext, type = 'bug', severity = 'medium', source = 'manual', title }) {
    if (!this._sessionId) throw new Error('Reporter: no active session');

    const res = await this._fetch('/api/findings', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: this._sessionId,
        projectId: this._projectId,
        annotation,
        browserContext,
        type,
        severity,
        source,
        title,
      }),
    });

    return res.data;
  }

  /**
   * Ask the AI to suggest a title, type, and severity for a finding.
   */
  async suggestTitle({ description, element, pageUrl, browserContext } = {}) {
    const res = await this._fetch('/api/findings/suggest-title', {
      method: 'POST',
      body: JSON.stringify({ description, element, pageUrl, browserContext }),
    });
    return res.data;
  }

  /**
   * End the current session.
   */
  async endSession() {
    await this.flush();
    this._stopFlushTimer();

    if (this._sessionId) {
      await this._fetch(`/api/sessions/${this._sessionId}/complete`, {
        method: 'POST',
      });
      this._sessionId = null;
    }
  }

  /**
   * Clean up — call on page unload.
   */
  destroy() {
    this._stopFlushTimer();
    if (this._sessionId) {
      this._sender.drainOnUnload();
      this._sessionId = null;
    }
  }

  // ── Private ───────────────────────────────

  _startFlushTimer() {
    this._stopFlushTimer();
    this._timer = setInterval(() => this.flush(), this._flushInterval);
  }

  _stopFlushTimer() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  async _fetch(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Sentinel-SDK': 'browser/1.0',
      ...options.headers,
    };

    if (this._apiKey) {
      headers['X-Sentinel-Key'] = this._apiKey;
    }

    const res = await fetch(`${this._serverUrl}${path}`, {
      ...options,
      headers,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || `HTTP ${res.status}`);
    }

    return res.json();
  }
}
