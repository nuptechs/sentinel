// ─────────────────────────────────────────────
// Sentinel — Adapter: Noop Trace
// No-op when backend tracing is not configured
// ─────────────────────────────────────────────

import { TracePort } from '../../core/ports/trace.port.js';

export class NoopTraceAdapter extends TracePort {
  async getTraces() { return []; }
  async getTraceByCorrelation() { return null; }
  createMiddleware() { return (_req, _res, next) => next(); }
  wrapPool(pool) { return pool; }
  async ensureRemoteSession() { return { ok: false }; }
  isConfigured() { return false; }
}
