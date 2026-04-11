// ─────────────────────────────────────────────
// Sentinel — Adapter: DebugProbe Trace (v2)
//
// Captures HTTP requests and SQL queries from the
// monitored backend. Uses AsyncLocalStorage for
// per-request context isolation and W3C Trace Context
// for interoperability with OpenTelemetry / APMs.
//
// v2 changes from v1:
//   - AsyncLocalStorage replaces global _activeEntry
//     (fixes race condition under concurrent requests)
//   - W3C traceparent header support
//   - Circuit breaker for remote Debug Probe API calls
//   - Backward-compatible with existing X-Sentinel-* headers
//
// ─────────────────────────────────────────────

import { TracePort } from '../../core/ports/trace.port.js';
import { runInContext, getTraceEntry } from '../../core/infra/async-context.js';
import { createTraceContext, formatTraceparent } from '../../core/infra/trace-context.js';
import { CircuitBreaker } from '../../core/infra/circuit-breaker.js';
import { randomUUID } from 'node:crypto';

export class DebugProbeTraceAdapter extends TracePort {
  /**
   * @param {object} [options]
   * @param {number} [options.maxTraces=10000]
   * @param {number} [options.maxAgeSec=3600]
   * @param {string} [options.baseUrl]
   * @param {string} [options.apiKey]
   * @param {number} [options.timeoutMs=5000]
   */
  constructor({
    maxTraces = 10_000,
    maxAgeSec = 3600,
    baseUrl = process.env.SENTINEL_TRACE_URL || process.env.DEBUG_PROBE_URL || process.env.PROBE_SERVER_URL || null,
    apiKey = process.env.SENTINEL_TRACE_API_KEY || process.env.PROBE_API_KEY || null,
    timeoutMs = 5000,
  } = {}) {
    super();
    this.maxTraces = maxTraces;
    this.maxAgeSec = maxAgeSec;
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null;
    this.apiKey = apiKey || null;
    this.timeoutMs = timeoutMs;

    // Primary store: Map<correlationId, TraceEntry>
    this.traces = new Map();

    // Secondary index: Map<sessionId, Set<correlationId>>
    this.sessionIndex = new Map();

    // Circuit breaker for remote Debug Probe API
    this._remoteBreaker = new CircuitBreaker({
      name: 'debugprobe-remote',
      failureThreshold: 3,
      windowMs: 60_000,
      recoveryMs: 30_000,
      timeoutMs: this.timeoutMs,
      isFailure: (err) => {
        // Only count network/server errors as failures,
        // not 4xx client errors (those are our fault)
        if (err?.status >= 400 && err?.status < 500) return false;
        return true;
      },
    });
  }

  // ── TracePort interface ───────────────────

  async getTraces(sessionId, { since, until, limit = 500 } = {}) {
    const fromTime = this._toTimestamp(since);
    const toTime = this._toTimestamp(until);

    // Try remote Debug Probe API first (if configured)
    if (this.baseUrl) {
      try {
        return await this._remoteBreaker.fire(
          () => this._fetchRemoteTraces(sessionId, { since: fromTime, until: toTime, limit }),
          // Fallback: return local traces if circuit is open
          undefined,
        );
      } catch (err) {
        // Circuit open or fetch failed — fall through to local store
        if (!err.isCircuitOpen) {
          console.warn(`[Sentinel] Debug Probe remote fetch failed for session ${sessionId}:`, err.message);
        }
      }
    }

    // Local in-memory store
    const correlationIds = this.sessionIndex.get(sessionId);
    if (!correlationIds) return [];

    let results = [];
    for (const cid of correlationIds) {
      const trace = this.traces.get(cid);
      if (!trace) continue;
      if (fromTime && trace.createdAt < fromTime) continue;
      if (toTime && trace.createdAt > toTime) continue;
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
   * Express middleware that captures HTTP request/response.
   *
   * Key design decisions:
   *   1. AsyncLocalStorage isolates each request's trace entry.
   *      The wrapPool() DB interceptor reads from the SAME context,
   *      so queries are correctly attributed to their originating
   *      request — even under concurrent load.
   *
   *   2. W3C traceparent is parsed from incoming headers and
   *      propagated. This enables distributed tracing across
   *      microservices using OpenTelemetry or any W3C-compliant APM.
   *
   *   3. Backward-compatible with X-Sentinel-Session,
   *      X-Sentinel-Correlation, and X-Request-Id headers.
   */
  createMiddleware() {
    const adapter = this;

    return (req, res, next) => {
      const sessionId = req.get('X-Sentinel-Session')
        || req.sentinelSessionId
        || req.query?._sentinel_session
        || null;

      if (!sessionId) {
        return next();
      }

      // Resolve trace & correlation identifiers
      const traceCtx = createTraceContext(req.get('traceparent'));
      const correlationId = req.get('X-Sentinel-Correlation')
        || req.get('X-Request-Id')
        || traceCtx.parentId;

      const startTime = Date.now();
      const startHrTime = process.hrtime.bigint();

      // Build the mutable trace entry for this request
      const entry = {
        correlationId,
        sessionId,
        traceId: traceCtx.traceId,
        spanId: traceCtx.parentId,
        request: {
          method: req.method,
          path: req.path,
          url: req.originalUrl,
          headers: adapter._sanitizeHeaders(req.headers),
          query: req.query,
          body: adapter._truncateBody(req.body),
          ip: req.ip,
        },
        response: null,
        queries: [],
        createdAt: startTime,
      };

      // Expose for downstream code that reads from req
      req._sentinelCorrelation = correlationId;
      req._sentinelTraceEntry = entry;

      // Set W3C traceparent on the response for downstream propagation
      if (typeof res.setHeader === 'function') {
        res.setHeader('traceparent', formatTraceparent(traceCtx));
      }

      // Capture response on finish
      const originalEnd = res.end;
      res.end = function sentinelResponseEnd(...args) {
        const durationNs = process.hrtime.bigint() - startHrTime;
        entry.response = {
          statusCode: res.statusCode,
          headers: adapter._sanitizeHeaders(res.getHeaders()),
          durationMs: Number(durationNs) / 1e6,
        };
        adapter._store(entry);
        return originalEnd.apply(res, args);
      };

      // Run the rest of the middleware chain inside an
      // AsyncLocalStorage context. Every downstream operation
      // (including DB queries) can read `getTraceEntry()` to
      // find THIS request's trace entry — no global state needed.
      runInContext(
        {
          correlationId,
          sessionId,
          traceId: traceCtx.traceId,
          spanId: traceCtx.parentId,
          traceEntry: entry,
        },
        () => next(),
      );
    };
  }

  /**
   * Wrap a pg Pool to intercept SQL queries.
   *
   * v2: Uses AsyncLocalStorage via getTraceEntry() to find the
   * correct trace entry for the current request. This eliminates
   * the race condition where concurrent requests would write
   * to each other's trace entries.
   *
   * If called outside a request context (e.g., startup, migration),
   * queries are silently ignored — they don't belong to any trace.
   */
  wrapPool(pool) {
    const adapter = this;
    const originalQuery = pool.query.bind(pool);

    pool.query = function sentinelWrappedQuery(...args) {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      const params = typeof args[0] === 'string' ? args[1] : args[0]?.values;
      const startHr = process.hrtime.bigint();

      const resultPromise = originalQuery(...args);

      resultPromise.then(
        (result) => {
          const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
          adapter._recordQuery({
            sql,
            params: adapter._sanitizeParams(params),
            durationMs,
            rowCount: result?.rowCount ?? null,
            error: null,
          });
        },
        (err) => {
          const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
          adapter._recordQuery({
            sql,
            params: adapter._sanitizeParams(params),
            durationMs,
            rowCount: null,
            error: err.message,
          });
        },
      );

      return resultPromise;
    };

    return pool;
  }

  isConfigured() {
    return true;
  }

  // ── Internal: query recording ─────────────

  /**
   * Record a query into the current request's trace entry.
   *
   * v2: Reads the trace entry from AsyncLocalStorage context.
   * If no context exists (call outside request lifecycle),
   * the query is silently dropped — this is intentional.
   */
  _recordQuery(queryInfo) {
    const entry = getTraceEntry();
    if (entry) {
      entry.queries.push(queryInfo);
    }
    // No context = query outside a traced request (startup, migration, etc.)
    // Silently ignoring is correct behavior.
  }

  // ── Internal: remote API ──────────────────

  async _fetchRemoteTraces(sessionId, { since, until, limit = 500 } = {}) {
    const params = new URLSearchParams({
      limit: String(Math.min(limit, 1000)),
      offset: '0',
    });

    if (since) params.set('fromTime', String(since));
    if (until) params.set('toTime', String(until));

    const payload = await this._fetchJSON(
      `/api/sessions/${encodeURIComponent(sessionId)}/events?${params.toString()}`
    );

    const events = Array.isArray(payload?.events) ? payload.events : [];
    const grouped = new Map();

    for (const event of events) {
      const cid = event?.correlationId || event?.requestId || event?.id || randomUUID();
      if (!grouped.has(cid)) {
        grouped.set(cid, {
          correlationId: cid,
          sessionId: event?.sessionId || sessionId,
          request: null,
          response: null,
          queries: [],
          createdAt: this._toTimestamp(event?.timestamp) || Date.now(),
        });
      }

      const entry = grouped.get(cid);
      entry.createdAt = Math.min(entry.createdAt, this._toTimestamp(event?.timestamp) || entry.createdAt);

      const data = event?.data || event?.payload || {};
      switch (event?.type) {
        case 'http-request':
          entry.request = {
            method: data.method || null,
            path: data.path || data.url || null,
            url: data.url || null,
            headers: this._sanitizeHeaders(data.headers),
            query: data.query || null,
            body: this._truncateBody(data.body),
            ip: data.ip || null,
          };
          break;
        case 'http-response':
          entry.response = {
            statusCode: data.statusCode || null,
            headers: this._sanitizeHeaders(data.headers),
            durationMs: data.durationMs || null,
          };
          break;
        case 'db-query':
          entry.queries.push({
            sql: data.query || data.sql || null,
            params: this._sanitizeParams(data.params),
            durationMs: data.durationMs || null,
            rowCount: data.rowCount ?? null,
            error: data.error || null,
          });
          break;
        default:
          break;
      }
    }

    return [...grouped.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((entry) => this._formatTrace(entry))
      .slice(0, limit);
  }

  async _fetchJSON(path) {
    const headers = { Accept: 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = new Error(`Debug Probe API error: ${response.status}`);
        err.status = response.status;
        throw err;
      }

      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── Internal: storage ─────────────────────

  _store(entry) {
    this.traces.set(entry.correlationId, entry);

    if (entry.sessionId) {
      if (!this.sessionIndex.has(entry.sessionId)) {
        this.sessionIndex.set(entry.sessionId, new Set());
      }
      this.sessionIndex.get(entry.sessionId).add(entry.correlationId);
    }

    // LRU eviction — remove oldest when over capacity
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

  _toTimestamp(value) {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // ── Internal: formatting ──────────────────

  _formatTrace(entry) {
    return {
      type: 'http_request',
      correlationId: entry.correlationId,
      sessionId: entry.sessionId,
      traceId: entry.traceId || null,
      spanId: entry.spanId || null,
      timestamp: entry.createdAt,
      payload: {
        path: entry.request?.path,
        method: entry.request?.method,
        url: entry.request?.url,
        statusCode: entry.response?.statusCode,
        durationMs: entry.response?.durationMs,
        queryCount: entry.queries?.length ?? 0,
        queries: entry.queries,
      },
    };
  }

  // ── Internal: sanitization ────────────────

  _sanitizeHeaders(headers) {
    if (!headers) return {};
    const sanitized = { ...headers };
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

  // ── Public: observability ─────────────────

  get size() {
    return this.traces.size;
  }

  getCircuitStatus() {
    return this._remoteBreaker.getStatus();
  }

  clear() {
    this.traces.clear();
    this.sessionIndex.clear();
  }
}
