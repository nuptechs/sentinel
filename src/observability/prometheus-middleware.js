// ─────────────────────────────────────────────
// Sentinel — Express middleware + /metrics endpoint
//
// Adapted from EasyNuP's prometheus-middleware.js (pure JS ESM).
// Route labels are normalized (UUID, numeric IDs → :id) to keep cardinality low.
// ─────────────────────────────────────────────

import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
} from './metrics.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Normalize route paths so metric labels stay bounded.
 * Prefers Express's matched-route pattern when available.
 */
export function normalizeRoute(req) {
  // Prefer Express matched pattern when baseUrl is informative
  if (req.route?.path && req.baseUrl) {
    return req.baseUrl + req.route.path;
  }

  let path = (req.originalUrl?.split('?')[0]) || req.path || '/';
  path = path.replace(UUID_RE, ':id');
  path = path.replace(/\/\d+(?=\/|$)/g, '/:id');
  // Replace alphanumeric id segments that look like random tokens (length >= 8 with digits+letters)
  path = path.replace(/\/[a-zA-Z0-9_-]{8,}(?=\/|$)/g, (seg) => {
    // Keep pure-alpha segments (likely endpoints), replace tokens with mixed digits
    return /\d/.test(seg) ? '/:id' : seg;
  });

  // Cap depth to prevent unbounded cardinality
  const segments = path.split('/').slice(0, 6);
  return segments.join('/');
}

const SKIP_PATHS = new Set(['/metrics', '/health', '/ready']);

/**
 * Express middleware that records HTTP request metrics.
 * Register after body parser / requestId, before auth.
 */
export function metricsMiddleware(req, res, next) {
  if (SKIP_PATHS.has(req.path)) return next();

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
    const labels = {
      method: req.method,
      route: normalizeRoute(req),
      status_code: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSec);
  });

  next();
}

/**
 * Express handler for GET /metrics.
 * Unauthenticated by convention (same as Debug Probe, EasyNuP, Prometheus best practice).
 */
export async function metricsEndpoint(_req, res) {
  try {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  } catch (err) {
    res.status(500).json({ error: 'Failed to collect metrics', message: err.message });
  }
}
