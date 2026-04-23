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
   * @param {import('../../core/ports/storage.port.js').StoragePort} [options.storage] — durable persistence (write-through)
   */
  constructor({
    maxTraces = 10_000,
    maxAgeSec = 3600,
    baseUrl = process.env.SENTINEL_TRACE_URL || process.env.DEBUG_PROBE_URL || process.env.PROBE_SERVER_URL || null,
    apiKey = process.env.SENTINEL_TRACE_API_KEY || process.env.PROBE_API_KEY || null,
    timeoutMs = 5000,
    storage = null,
  } = {}) {
    super();
    this.maxTraces = maxTraces;
    this.maxAgeSec = maxAgeSec;
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null;
    this.apiKey = apiKey || null;
    this.timeoutMs = timeoutMs;
    this._storage = storage;

    // Primary store: Map<correlationId, TraceEntry>
    this.traces = new Map();

    // Secondary index: Map<sessionId, Set<correlationId>>
    this.sessionIndex = new Map();

    // Sentinel session id → Debug Probe remote session id.
    // Populated by ensureRemoteSession(); consumed by _forwardToRemote()
    // so trace entries captured by the middleware can be pushed to the
    // correct remote session.
    this._sessionMap = new Map();

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

    const merged = new Map();

    // Durable store (PostgreSQL) — historical traces survive restarts.
    // We merge persisted + in-memory traces so fresh hot-cache entries are
    // never hidden by eventual/asynchronous persistence writes.
    if (this._storage) {
      try {
        const persisted = await this._storage.getTracesBySession(sessionId, {
          since: fromTime, until: toTime, limit,
        });
        for (const trace of persisted) {
          const formatted = this._formatTrace(trace);
          merged.set(formatted.correlationId, formatted);
        }
      } catch (err) {
        console.warn('[Sentinel] Trace persistence read failed:', err.message);
      }
    }

    // Local in-memory store (hot cache)
    const correlationIds = this.sessionIndex.get(sessionId);
    if (correlationIds) {
      for (const cid of correlationIds) {
        const trace = this.traces.get(cid);
        if (!trace) continue;
        if (fromTime && trace.createdAt < fromTime) continue;
        if (toTime && trace.createdAt > toTime) continue;
        const formatted = this._formatTrace(trace);
        merged.set(formatted.correlationId, formatted);
      }
    }

    const results = [...merged.values()]
      .sort((a, b) => a.timestamp - b.timestamp);

    return results.slice(0, limit);
  }

  async getTraceByCorrelation(correlationId) {
    // Fast path: in-memory cache
    const trace = this.traces.get(correlationId);
    if (trace) return this._formatTrace(trace);

    // Slow path: durable store
    if (this._storage) {
      try {
        const persisted = await this._storage.getTraceByCorrelation(correlationId);
        if (persisted) return this._formatTrace(persisted);
      } catch (err) {
        console.warn('[Sentinel] Trace persistence read failed:', err.message);
      }
    }

    return null;
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

      // Resolve trace & correlation identifiers.
      // Accepted aliases (in priority order):
      //   1. X-Sentinel-Correlation  — native Sentinel header
      //   2. X-Probe-Correlation-Id  — Debug Probe native header (Gap 7)
      //   3. X-Request-Id            — common industry header
      //   4. traceparent parent-id   — W3C fallback
      const traceCtx = createTraceContext(req.get('traceparent'));
      const correlationId = req.get('X-Sentinel-Correlation')
        || req.get('X-Probe-Correlation-Id')
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

      // Set W3C traceparent on the response for downstream propagation,
      // plus the cross-system correlation aliases (Gap 7).
      if (typeof res.setHeader === 'function') {
        res.setHeader('traceparent', formatTraceparent(traceCtx));
        res.setHeader('X-Sentinel-Correlation', correlationId);
        res.setHeader('X-Probe-Correlation-Id', correlationId);
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

      // Debug Probe emits fields at the top level of the event; older
      // payload shapes placed them under `.data` / `.payload`. Read from
      // either location so both contracts compose.
      const data = event?.data || event?.payload || {};
      const pick = (key) => data[key] ?? event?.[key];

      // Event type normalization — Debug Probe actually emits:
      //   source:'network' type:'request' | 'response'
      //   source:'sdk'     type:'request-start' | 'request-end' | 'db-query'
      // Legacy/expected names also accepted: http-request, http-response.
      const rawType = event?.type;
      const source = event?.source;
      const normalizedType =
        rawType === 'http-request' || rawType === 'request-start' || (source === 'network' && rawType === 'request')
          ? 'http-request'
          : rawType === 'http-response' || rawType === 'request-end' || (source === 'network' && rawType === 'response')
            ? 'http-response'
            : rawType === 'db-query'
              ? 'db-query'
              : null;

      switch (normalizedType) {
        case 'http-request':
          entry.request = {
            method: pick('method') || null,
            path: pick('path') || pick('url') || null,
            url: pick('url') || null,
            headers: this._sanitizeHeaders(pick('headers')),
            query: pick('query') || null,
            body: this._truncateBody(pick('body')),
            ip: pick('ip') || null,
          };
          break;
        case 'http-response':
          entry.response = {
            statusCode: pick('statusCode') ?? pick('status') ?? null,
            headers: this._sanitizeHeaders(pick('headers')),
            durationMs: pick('durationMs') ?? pick('duration') ?? null,
          };
          break;
        case 'db-query':
          entry.queries.push({
            sql: pick('query') || pick('sql') || null,
            params: this._sanitizeParams(pick('params')),
            durationMs: pick('durationMs') ?? pick('duration') ?? null,
            rowCount: pick('rowCount') ?? null,
            error: pick('error') || null,
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

  /**
   * Mirror-create the Sentinel session on the remote Debug Probe so that
   * subsequent ingests and event queries key off the same session id.
   * Debug Probe's POST /api/sessions currently uses `.strict()` on
   * {name, config, tags}. We stuff Sentinel's session id into `name`
   * (so it's retrievable) and pack projectId/metadata into `tags` as
   * prefixed strings, staying within the accepted schema.
   *
   * Non-throwing — every failure is captured into the return envelope.
   */
  async ensureRemoteSession(session) {
    if (!this.baseUrl || !session?.id) return { ok: false };

    const tags = [];
    if (session.projectId) tags.push(`sentinel:project:${session.projectId}`);
    tags.push(`sentinel:session:${session.id}`);
    if (session.metadata?.source) tags.push(`sentinel:source:${session.metadata.source}`);

    // Gap 4 — Debug Probe now accepts structured integration fields. We
    // populate both the legacy tag-prefixed format and the new first-class
    // fields so older probes still receive the info via tags.
    const body = {
      name: `sentinel-${session.id}`,
      tags,
      externalSessionId: session.id,
    };
    if (session.projectId) body.projectId = session.projectId;
    if (session.metadata && typeof session.metadata === 'object') {
      const flat = {};
      for (const [k, v] of Object.entries(session.metadata)) {
        if (v !== null && v !== undefined) flat[k] = String(v);
      }
      if (Object.keys(flat).length > 0) body.metadata = flat;
    }

    try {
      const remote = await this._remoteBreaker.fire(
        () => this._fetchJSON('/api/sessions', { method: 'POST', body }),
      );
      const remoteSessionId = remote?.id || remote?.data?.id || null;
      if (remoteSessionId) {
        this._sessionMap.set(session.id, remoteSessionId);
      }
      return { ok: true, remoteSessionId };
    } catch (err) {
      // Gap 4 compatibility — older Debug Probe instances still use
      // `.strict()` on the create-session schema and will reject the new
      // `projectId`/`metadata`/`externalSessionId` fields with 400. Retry
      // once with the legacy tags-only payload so rollouts don't break.
      if (err?.status === 400 && (body.projectId || body.metadata || body.externalSessionId)) {
        try {
          const legacyBody = { name: body.name, tags: body.tags };
          const remote = await this._remoteBreaker.fire(
            () => this._fetchJSON('/api/sessions', { method: 'POST', body: legacyBody }),
          );
          const remoteSessionId = remote?.id || remote?.data?.id || null;
          if (remoteSessionId) this._sessionMap.set(session.id, remoteSessionId);
          return { ok: true, remoteSessionId, degraded: 'legacy-schema' };
        } catch (fallbackErr) {
          if (!fallbackErr?.isCircuitOpen) {
            console.warn(`[Sentinel] Debug Probe ensureRemoteSession fallback failed: ${fallbackErr.message}`);
          }
          return { ok: false, error: fallbackErr.message };
        }
      }
      if (!err?.isCircuitOpen) {
        console.warn(`[Sentinel] Debug Probe ensureRemoteSession failed: ${err.message}`);
      }
      return { ok: false, error: err.message };
    }
  }

  /**
   * Gap 10 — bridge Debug Probe's WebSocket so subscribers receive realtime
   * events without polling. Non-throwing: when the remote is unconfigured,
   * unknown, or the circuit breaker is open, returns a no-op unsubscribe.
   *
   * @param {string} sessionId — Sentinel session id
   * @param {(event:object) => void} listener
   * @returns {Promise<() => void>} unsubscribe function
   */
  async subscribe(sessionId, listener) {
    if (typeof listener !== 'function') return () => {};
    if (!this.baseUrl || !sessionId) return () => {};
    if (this._remoteBreaker?.isOpen?.()) return () => {};

    const remoteSessionId = this._sessionMap.get(sessionId) || sessionId;
    const wsUrl = this.baseUrl.replace(/^http/i, 'ws');
    const urlWithAuth = this.apiKey
      ? `${wsUrl}/?token=${encodeURIComponent(this.apiKey)}`
      : `${wsUrl}/`;

    let closed = false;
    let ws = null;
    let retryTimer = null;
    let attempt = 0;

    const connect = async () => {
      if (closed) return;
      const { WebSocket } = await import('ws');
      try {
        ws = new WebSocket(urlWithAuth, {
          headers: this.apiKey ? { 'X-API-Key': this.apiKey } : {},
          handshakeTimeout: this.timeoutMs,
        });
      } catch (err) {
        console.warn(`[Sentinel] Debug Probe subscribe: failed to open socket: ${err.message}`);
        scheduleRetry();
        return;
      }

      ws.on('open', () => {
        attempt = 0;
        try {
          ws.send(JSON.stringify({ type: 'subscribe', sessionId: remoteSessionId }));
        } catch { /* ignore — will retry on reconnect */ }
      });

      ws.on('message', (raw) => {
        if (closed) return;
        try {
          const msg = JSON.parse(raw.toString());
          if (msg?.type === 'event' && msg.event) {
            listener(msg.event);
          }
        } catch { /* malformed frame — skip */ }
      });

      ws.on('error', (err) => {
        if (!closed) {
          console.warn(`[Sentinel] Debug Probe subscribe error: ${err.message}`);
        }
      });

      ws.on('close', () => {
        if (!closed) scheduleRetry();
      });
    };

    const scheduleRetry = () => {
      if (closed) return;
      attempt += 1;
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect().catch(() => { /* handled below */ });
      }, delay);
      // Allow process to exit if retry is the only pending timer
      if (typeof retryTimer?.unref === 'function') retryTimer.unref();
    };

    connect().catch((err) => {
      console.warn(`[Sentinel] Debug Probe subscribe: ${err.message}`);
    });

    return () => {
      if (closed) return;
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try {
        if (ws && ws.readyState <= 1 /* CONNECTING or OPEN */) ws.close();
      } catch { /* ignore */ }
    };
  }

  async _fetchJSON(path, { method = 'GET', body = null } = {}) {
    const headers = { Accept: 'application/json' };
    if (this.apiKey) {
      // Debug Probe server expects X-API-Key. We also send Authorization:
      // Bearer for backward compatibility with legacy/JWT-protected probes.
      headers['X-API-Key'] = this.apiKey;
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    if (body != null) {
      headers['Content-Type'] = 'application/json';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body != null ? JSON.stringify(body) : undefined,
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
    // In-memory cache (fast reads)
    this.traces.set(entry.correlationId, entry);

    if (entry.sessionId) {
      if (!this.sessionIndex.has(entry.sessionId)) {
        this.sessionIndex.set(entry.sessionId, new Set());
      }
      this.sessionIndex.get(entry.sessionId).add(entry.correlationId);
    }

    // Write-through to durable store (non-blocking)
    if (this._storage) {
      this._storage.storeTrace(entry).catch((err) => {
        console.warn('[Sentinel] Trace persistence write failed:', err.message);
      });
    }

    // Fire-and-forget forward to remote Debug Probe so traces captured
    // locally via the Express middleware are also visible on the central
    // probe. Only fires when we know the remote session id (populated by
    // ensureRemoteSession) and a baseUrl is configured. Never throws.
    if (this.baseUrl && entry.sessionId && this._sessionMap.has(entry.sessionId)) {
      this._forwardToRemote(entry).catch(() => { /* silent */ });
    }

    // LRU eviction — remove oldest when over capacity
    if (this.traces.size > this.maxTraces) {
      const oldestKey = this.traces.keys().next().value;
      this._evict(oldestKey);
    }
  }

  /**
   * Transform a local TraceEntry into Debug Probe events and POST them
   * as a single batch. Non-blocking, failures are swallowed.
   *
   * Emits three flavors of events (schema required fields: id, sessionId,
   * timestamp, source):
   *   - source='sdk', type='request-start' — request metadata
   *   - source='sdk', type='request-end'   — response metadata
   *   - source='sdk', type='db-query'      — one per SQL query
   */
  async _forwardToRemote(entry) {
    const remoteSessionId = this._sessionMap.get(entry.sessionId);
    if (!remoteSessionId) return;

    const base = {
      sessionId: remoteSessionId,
      source: 'sdk',
      correlationId: entry.correlationId,
    };
    const events = [];

    if (entry.request) {
      events.push({
        ...base,
        id: `${entry.correlationId}:req`,
        timestamp: entry.createdAt || Date.now(),
        type: 'request-start',
        method: entry.request.method,
        url: entry.request.url || entry.request.path,
        path: entry.request.path,
        ip: entry.request.ip,
      });
    }
    if (entry.response) {
      const reqStart = entry.createdAt || Date.now();
      events.push({
        ...base,
        id: `${entry.correlationId}:res`,
        timestamp: reqStart + (entry.response.durationMs || 0),
        type: 'request-end',
        statusCode: entry.response.statusCode,
        durationMs: entry.response.durationMs,
      });
    }
    if (Array.isArray(entry.queries)) {
      for (let i = 0; i < entry.queries.length; i++) {
        const q = entry.queries[i];
        events.push({
          ...base,
          id: `${entry.correlationId}:q${i}`,
          timestamp: (entry.createdAt || Date.now()) + i,
          type: 'db-query',
          query: q.sql,
          durationMs: q.durationMs,
          rowCount: q.rowCount,
          error: q.error || undefined,
        });
      }
    }

    if (events.length === 0) return;

    try {
      await this._remoteBreaker.fire(
        () => this._fetchJSON(
          `/api/sessions/${encodeURIComponent(remoteSessionId)}/events`,
          { method: 'POST', body: { events } },
        ),
      );
    } catch (err) {
      if (!err?.isCircuitOpen) {
        console.warn(`[Sentinel] Debug Probe forward failed: ${err.message}`);
      }
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
