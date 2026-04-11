// ─────────────────────────────────────────────
// Sentinel — W3C Trace Context (traceparent)
//
// Implements the W3C Trace Context specification:
//   https://www.w3.org/TR/trace-context/
//
// Format: {version}-{trace-id}-{parent-id}-{trace-flags}
// Example: 00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-01
//
// This enables interoperability with:
//   - OpenTelemetry (native W3C support)
//   - Sentry (W3C + sentry-trace)
//   - Datadog (W3C + x-datadog-*)
//   - Jaeger, Zipkin, and any W3C-compliant system
//
// The Sentinel system propagates:
//   - traceparent: standard W3C header
//   - X-Sentinel-Session: Sentinel-specific session ID
//   - X-Sentinel-Correlation: backward-compat alias for parent-id
//
// ─────────────────────────────────────────────

import { randomBytes } from 'node:crypto';

const VERSION = '00';
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * @typedef {object} TraceContext
 * @property {string} version    — always '00'
 * @property {string} traceId    — 32 hex chars (128-bit)
 * @property {string} parentId   — 16 hex chars (64-bit), also called span-id
 * @property {string} traceFlags — 2 hex chars (sampled = '01')
 */

/**
 * Parse a `traceparent` header value.
 * Returns null if the header is invalid or missing.
 *
 * @param {string | null | undefined} header
 * @returns {TraceContext | null}
 */
export function parseTraceparent(header) {
  if (!header || typeof header !== 'string') return null;

  const match = header.trim().toLowerCase().match(TRACEPARENT_RE);
  if (!match) return null;

  const [, version, traceId, parentId, traceFlags] = match;

  // version 'ff' is reserved / invalid
  if (version === 'ff') return null;

  // All zeros is invalid per spec
  if (traceId === '0'.repeat(32)) return null;
  if (parentId === '0'.repeat(16)) return null;

  return { version, traceId, parentId, traceFlags };
}

/**
 * Format a TraceContext back into a `traceparent` header value.
 *
 * @param {TraceContext} ctx
 * @returns {string}
 */
export function formatTraceparent(ctx) {
  return `${ctx.version}-${ctx.traceId}-${ctx.parentId}-${ctx.traceFlags}`;
}

/**
 * Generate a new random trace ID (32 hex = 128 bits).
 * @returns {string}
 */
export function generateTraceId() {
  return randomBytes(16).toString('hex');
}

/**
 * Generate a new random span/parent ID (16 hex = 64 bits).
 * @returns {string}
 */
export function generateSpanId() {
  return randomBytes(8).toString('hex');
}

/**
 * Create a full TraceContext, either from an incoming
 * `traceparent` header or by generating fresh IDs.
 *
 * When an incoming traceparent is valid, we preserve the
 * trace-id and create a new span-id (we are a new span
 * in the existing trace). When no valid traceparent is
 * provided, we start a new trace.
 *
 * @param {string | null} incomingTraceparent
 * @returns {TraceContext}
 */
export function createTraceContext(incomingTraceparent) {
  const parsed = parseTraceparent(incomingTraceparent);

  if (parsed) {
    // Continue existing trace, new span
    return {
      version: VERSION,
      traceId: parsed.traceId,
      parentId: generateSpanId(),
      traceFlags: parsed.traceFlags,
    };
  }

  // Start a brand new trace
  return {
    version: VERSION,
    traceId: generateTraceId(),
    parentId: generateSpanId(),
    traceFlags: '01', // sampled
  };
}
