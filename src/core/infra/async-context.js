// ─────────────────────────────────────────────
// Sentinel — AsyncLocalStorage Request Context
//
// Provides per-request isolation for trace correlation.
// Every middleware, DB interceptor, and service call within
// the same async chain shares the same context — without
// global mutable state.
//
// This is the same pattern used by:
//   - OpenTelemetry SDK (context propagation)
//   - Debug Probe (packages/sdk/src/node/context.ts)
//   - Datadog dd-trace (CLS-hooked / ALS)
//
// Why AsyncLocalStorage:
//   Node.js 16+ ships AsyncLocalStorage as a stable API.
//   It propagates values through the entire async call graph
//   of a single request — setTimeout, Promise chains, event
//   emitters — with zero manual plumbing. This makes it the
//   correct mechanism for request-scoped context in Node.
//
// ─────────────────────────────────────────────

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Singleton store. Each HTTP request runs inside its own
 * context via `store.run(ctx, callback)`. All downstream
 * code — including DB interceptors — reads from the same
 * context without race conditions.
 */
const store = new AsyncLocalStorage();

/**
 * @typedef {object} RequestContext
 * @property {string}  correlationId — unique ID tying frontend → backend → DB
 * @property {string}  [sessionId]   — Sentinel capture session
 * @property {string}  [traceId]     — W3C trace-id (32 hex)
 * @property {string}  [spanId]      — W3C parent-id / span-id (16 hex)
 * @property {object}  [traceEntry]  — mutable trace record for this request
 */

/**
 * Run `fn` in an isolated context.
 *
 * @param {RequestContext} ctx
 * @param {function} fn — the function to run within this context
 * @returns {*} — return value of fn
 */
export function runInContext(ctx, fn) {
  return store.run(ctx, fn);
}

/**
 * Get the current request context, or null if called
 * outside any active context (e.g. startup code, timers
 * not spawned from a request).
 *
 * @returns {RequestContext | null}
 */
export function getContext() {
  return store.getStore() ?? null;
}

/**
 * Get the current correlation ID, or null.
 * Convenience shorthand used in DB interceptors.
 *
 * @returns {string | null}
 */
export function getCorrelationId() {
  return store.getStore()?.correlationId ?? null;
}

/**
 * Get the current trace entry (mutable reference),
 * or null. Used by the DB interceptor to append query
 * records to the correct request's trace.
 *
 * @returns {object | null}
 */
export function getTraceEntry() {
  return store.getStore()?.traceEntry ?? null;
}
