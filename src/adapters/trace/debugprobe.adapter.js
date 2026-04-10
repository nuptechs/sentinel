// ─────────────────────────────────────────────
// Sentinel — Adapter: DebugProbe Trace
// Captures HTTP requests and SQL queries in the
// monitored backend via middleware + pool wrapping.
// Stores traces in-memory keyed by session/correlation.
// ─────────────────────────────────────────────

import { TracePort } from '../../core/ports/trace.port.js';
import { v4 as uuid } from 'uuid';

/**
 * DebugProbe captures traces from:
 * 1. Express middleware → HTTP request/response (method, path, status, timing)
 * 2. Pool wrapper → SQL queries (query, params, duration)
 *
 * Traces are correlated via X-Sentinel-Correlation header or X-Request-Id.
 * They are stored in-memory with LRU eviction by maxTraces.
 */
export class DebugProbeTraceAdapter extends TracePort {
  /**
   * @param {object} [options]
   * @param {number} [options.maxTraces=10000] — max traces to keep in memory
   * @param {number} [options.maxAgeSec=3600]  — evict traces older than this
   */
  constructor({ maxTraces = 10_000, maxAgeSec = 3600 } = {}) {
    super();
    this.maxTraces = maxTraces;
    this.maxAgeSec = maxAgeSec;

    // Store: Map<correlationId, TraceEntry>
    // TraceEntry = { correlationId, sessionId, request, response, queries[], createdAt }
    this.traces = new Map();

    // Secondary index: Map<sessionId, Set<correlationId>>
    this.sessionIndex = new Map();
  }

  // ── TracePort interface ───────────────────

  async getTraces(sessionId, { since, until, limit = 500 } = {}) {
    const correlationIds = this.sessionIndex.get(sessionId);
    if (!correlationIds) return [];

    let results = [];
    for (const cid of correlationIds) {
      const trace = this.traces.get(cid);
      if (!trace) continue;
      if (since && trace.createdAt < since) continue;
      if (until && trace.createdAt > until) continue;
      results.push(this._formatTrace(trace));
    }

    results.sort((a, b) => a.timestamp - b.timestamp);
    return results.slice(0, limit);
  }

  async getTraceByCorrelation(correlationId) {
    const trace = this.traces.get(correlationId);
    if (!trace) return null;
    return this._formatTrace(trace);
  }

  /**
   * Express middleware that captures HTTP request/response details.
   * Must be placed AFTER request-id middleware and BEFORE route handlers.
   *
   * Looks for session ID in:
   *   - X-Sentinel-Session header
   *   - req.sentinelSessionId (set by SDK)
   *   - query param ?_sentinel_session=...
   */
  createMiddleware() {
    return (req, res, next) => {
      const correlationId = req.get('X-Sentinel-Correlation')
        || req.get('X-Request-Id')
        || uuid();

      const sessionId = req.get('X-Sentinel-Session')
        || req.sentinelSessionId
        || req.query?._sentinel_session
        || null;

      if (!sessionId) {
        // Without a session, we can't correlate — skip capture
        return next();
      }

      const startTime = Date.now();
      const startHrTime = process.hrtime.bigint();

      // Create trace entry
      const entry = {
        correlationId,
        sessionId,
        request: {
          method: req.method,
          path: req.path,
          url: req.originalUrl,
          headers: this._sanitizeHeaders(req.headers),
          query: req.query,
          body: this._truncateBody(req.body),
          ip: req.ip,
        },
        response: null,
        queries: [],
        createdAt: startTime,
      };

      // Expose correlation ID for SQL wrapping
      req._sentinelCorrelation = correlationId;
      req._sentinelTraceEntry = entry;

      // Set active entry so wrapPool() can correlate SQL queries to this request
      this.setActiveEntry(entry);

      // Capture response on finish
      const originalEnd = res.end;
      res.end = (...args) => {
        const durationNs = process.hrtime.bigint() - startHrTime;
        entry.response = {
          statusCode: res.statusCode,
          headers: this._sanitizeHeaders(res.getHeaders()),
          durationMs: Number(durationNs) / 1e6,
        };

        // Clear active entry to avoid cross-request leakage
        this._activeEntry = null;

        this._store(entry);
        return originalEnd.apply(res, args);
      };

      next();
    };
  }

  /**
   * Wrap a pg Pool to intercept SQL queries.
   * Each query is tagged with the current correlation ID
   * (set by middleware via AsyncLocalStorage patterns or req attachment).
   */
  wrapPool(pool) {
    const adapter = this;
    const originalQuery = pool.query.bind(pool);

    pool.query = function sentinelWrappedQuery(...args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const params = typeof args[0] === 'string' ? args[1] : args[0]?.values;

      const startHr = process.hrtime.bigint();

      const resultPromise = originalQuery(...args);

      // Attach timing after query completes
      resultPromise.then(
        (result) => {
          const durationNs = process.hrtime.bigint() - startHr;
          adapter._recordQuery({
            sql,
            params: adapter._sanitizeParams(params),
            durationMs: Number(durationNs) / 1e6,
            rowCount: result?.rowCount ?? null,
            error: null,
          });
        },
        (err) => {
          const durationNs = process.hrtime.bigint() - startHr;
          adapter._recordQuery({
            sql,
            params: adapter._sanitizeParams(params),
            durationMs: Number(durationNs) / 1e6,
            rowCount: null,
            error: err.message,
          });
        }
      );

      return resultPromise;
    };

    return pool;
  }

  isConfigured() {
    return true;
  }

  // ── Internal helpers ──────────────────────

  _store(entry) {
    this.traces.set(entry.correlationId, entry);

    // Update session index
    if (entry.sessionId) {
      if (!this.sessionIndex.has(entry.sessionId)) {
        this.sessionIndex.set(entry.sessionId, new Set());
      }
      this.sessionIndex.get(entry.sessionId).add(entry.correlationId);
    }

    // LRU eviction
    if (this.traces.size > this.maxTraces) {
      const oldestKey = this.traces.keys().next().value;
      this._evict(oldestKey);
    }
  }

  _evict(correlationId) {
    const entry = this.traces.get(correlationId);
    if (entry?.sessionId) {
      const sessionSet = this.sessionIndex.get(entry.sessionId);
      if (sessionSet) {
        sessionSet.delete(correlationId);
        if (sessionSet.size === 0) this.sessionIndex.delete(entry.sessionId);
      }
    }
    this.traces.delete(correlationId);
  }

  _recordQuery(queryInfo) {
    // Since we can't use AsyncLocalStorage without extra wiring,
    // queries are recorded to a "pending" buffer.
    // The middleware associates them via timing/correlation.
    // For the MVP, queries are appended to the most recent trace entry.
    if (this._activeEntry) {
      this._activeEntry.queries.push(queryInfo);
    }
  }

  /**
   * Call this inside the middleware chain to set the active entry
   * for SQL correlation within the same request lifecycle.
   */
  setActiveEntry(entry) {
    this._activeEntry = entry;
  }

  _formatTrace(entry) {
    return {
      type: 'http_request',
      correlationId: entry.correlationId,
      sessionId: entry.sessionId,
      timestamp: entry.createdAt,
      payload: {
        path: entry.request?.path,
        method: entry.request?.method,
        url: entry.request?.url,
        statusCode: entry.response?.statusCode,
        durationMs: entry.response?.durationMs,
        queries: entry.queries,
      },
    };
  }

  _sanitizeHeaders(headers) {
    if (!headers) return {};
    const sanitized = { ...headers };
    // Remove sensitive headers
    delete sanitized.authorization;
    delete sanitized.cookie;
    delete sanitized['set-cookie'];
    delete sanitized['x-api-key'];
    return sanitized;
  }

  _truncateBody(body) {
    if (!body) return null;
    const str = typeof body === 'string' ? body : JSON.stringify(body);
    if (str.length > 4096) return str.slice(0, 4096) + '... [truncated]';
    try { return JSON.parse(str); } catch { return str; }
  }

  _sanitizeParams(params) {
    if (!Array.isArray(params)) return params;
    return params.map(p => {
      if (typeof p === 'string' && p.length > 256) {
        return p.slice(0, 256) + '...[truncated]';
      }
      return p;
    });
  }

  /**
   * Get total trace count (for monitoring).
   */
  get size() {
    return this.traces.size;
  }

  /**
   * Clear all traces (for testing).
   */
  clear() {
    this.traces.clear();
    this.sessionIndex.clear();
  }
}
