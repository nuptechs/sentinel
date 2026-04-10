// ─────────────────────────────────────────────
// Sentinel — Rate Limiter Middleware
// In-memory sliding window rate limiter
// No external dependencies required
// ─────────────────────────────────────────────

import { SentinelError } from '../../core/errors.js';

class RateLimitError extends SentinelError {
  constructor(retryAfterSec) {
    super('Too many requests', 429, 'RATE_LIMIT', { retryAfter: retryAfterSec });
  }
}

/**
 * Create a rate limiter middleware.
 *
 * @param {object} options
 * @param {number} [options.maxRequests=100] — max requests per window
 * @param {number} [options.windowMs=60000]  — window size in ms (default 1 min)
 * @param {function} [options.keyFn]         — function(req) → string key (default: IP)
 */
export function rateLimiter({ maxRequests = 100, windowMs = 60_000, keyFn } = {}) {
  const hits = new Map(); // key → { count, resetAt }

  // Cleanup expired entries every 5 minutes
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }, 5 * 60_000);
  cleanup.unref();

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();

    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }

    bucket.count++;

    // Set standard rate limit headers
    const remaining = Math.max(0, maxRequests - bucket.count);
    res.set('X-RateLimit-Limit', String(maxRequests));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      throw new RateLimitError(retryAfter);
    }

    next();
  };
}
