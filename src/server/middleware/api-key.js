// ─────────────────────────────────────────────
// Sentinel — API Key Authentication Middleware
// Validates X-Sentinel-Key header against env var
// ─────────────────────────────────────────────

import { SentinelError } from '../../core/errors.js';

class AuthError extends SentinelError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'AUTH_ERROR');
  }
}

/**
 * Middleware that validates API key from X-Sentinel-Key or Authorization: Bearer header.
 *
 * If SENTINEL_API_KEY env var is not set, all requests are allowed
 * (open mode for local dev).
 *
 * Supports multiple keys separated by comma for key rotation:
 *   SENTINEL_API_KEY="new-key,old-key"
 */
export function apiKeyAuth(req, res, next) {
  const configuredKeys = process.env.SENTINEL_API_KEY;

  // No key configured → open mode (local dev)
  if (!configuredKeys) {
    return next();
  }

  // Accept key from X-Sentinel-Key header or Authorization: Bearer
  const providedKey = req.get('X-Sentinel-Key')
    || extractBearerToken(req.get('Authorization'));

  if (!providedKey) {
    throw new AuthError('Missing X-Sentinel-Key or Authorization header');
  }

  const validKeys = configuredKeys.split(',').map(k => k.trim()).filter(Boolean);

  // Constant-time-ish comparison to avoid timing attacks
  const isValid = validKeys.some(key => {
    if (key.length !== providedKey.length) return false;
    let result = 0;
    for (let i = 0; i < key.length; i++) {
      result |= key.charCodeAt(i) ^ providedKey.charCodeAt(i);
    }
    return result === 0;
  });

  if (!isValid) {
    throw new AuthError('Invalid API key');
  }

  next();
}

/**
 * Extract token from "Bearer <token>" format.
 */
function extractBearerToken(header) {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}
