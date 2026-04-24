// ─────────────────────────────────────────────
// Sentinel — Prometheus metrics registry
//
// Follows the same pattern used across the workspace:
//   - Debug Probe: server/src/lib/metrics.ts (prom-client 15)
//   - EasyNuP:     packages/core/src/observability/metrics.js
//   - NuPIdentify: server/lib/metrics.ts
//
// Uses an isolated Registry so tests don't pollute the global one.
// ─────────────────────────────────────────────

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'sentinel_' });

// ── HTTP ────────────────────────────────────
export const httpRequestsTotal = new Counter({
  name: 'sentinel_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'sentinel_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ── Findings ────────────────────────────────
export const findingsCreatedTotal = new Counter({
  name: 'sentinel_findings_created_total',
  help: 'Total findings created',
  labelNames: ['source', 'type'],
  registers: [registry],
});

// ── Diagnosis ───────────────────────────────
export const diagnosesTotal = new Counter({
  name: 'sentinel_diagnoses_total',
  help: 'Total diagnosis attempts',
  labelNames: ['outcome'], // success | failed | ai_unavailable
  registers: [registry],
});

export const diagnosisDuration = new Histogram({
  name: 'sentinel_diagnosis_duration_seconds',
  help: 'Duration of the full diagnose() pipeline in seconds',
  labelNames: ['outcome'],
  buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

// ── Live enrichment (enrichWithLiveTraces) ──
export const enrichLiveTotal = new Counter({
  name: 'sentinel_enrich_live_total',
  help: 'Total enrich-live invocations',
  labelNames: ['outcome'], // collected | skipped_unconfigured | skipped_failed | not_found
  registers: [registry],
});

export const enrichLiveEventsCollected = new Histogram({
  name: 'sentinel_enrich_live_events_collected',
  help: 'Number of live events collected per enrichment call',
  buckets: [0, 1, 5, 10, 25, 50, 100, 250, 500],
  registers: [registry],
});

// ── Auto-enrichment (diagnose() pre-step) ───
export const autoEnrichTotal = new Counter({
  name: 'sentinel_auto_enrich_total',
  help: 'Total auto-enrich attempts performed inside diagnose()',
  labelNames: ['outcome'], // collected | skipped | failed | disabled
  registers: [registry],
});

// ── Auto-processing (fire-and-forget diagnose + correction after POST /findings) ──
export const autoProcessTotal = new Counter({
  name: 'sentinel_auto_process_total',
  help: 'Total auto-process (diagnose+correct) attempts after finding creation',
  labelNames: ['stage', 'outcome'], // stage: diagnose|correct ; outcome: success|failed|retried
  registers: [registry],
});

/**
 * Reset all metrics. Used by tests to keep runs isolated.
 */
export function resetMetrics() {
  registry.resetMetrics();
}
