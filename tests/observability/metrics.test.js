// ─────────────────────────────────────────────
// Tests — Prometheus /metrics endpoint + middleware + service instrumentation
// ─────────────────────────────────────────────

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { SessionService } from '../../src/core/services/session.service.js';
import { FindingService } from '../../src/core/services/finding.service.js';
import { DiagnosisService } from '../../src/core/services/diagnosis.service.js';
import { CorrectionService } from '../../src/core/services/correction.service.js';
import { registry, resetMetrics } from '../../src/observability/metrics.js';

function makeRequest(server, method, path, body = null, headers = {}) {
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}${path}`;
  return new Promise((resolve, reject) => {
    const r = http.request(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

const noopAI = { isConfigured: () => false, diagnose: async () => ({}), generateCorrection: async () => ({}), clarify: async () => '' };
const noopTrace = { isConfigured: () => false, getTraces: async () => [] };
const noopAnalyzer = { isConfigured: () => false, resolveEndpoint: async () => null, getSourceFile: async () => null };
const noopNotification = { isConfigured: () => false, onDiagnosisReady: async () => {}, onCorrectionReady: async () => {} };

async function seedSessionFinding(storage, findings, suffix) {
  const id = `s-${suffix}`;
  await storage.createSession({ id, projectId: 'p1', status: 'capturing', startedAt: new Date().toISOString(), endedAt: null, events: [], metadata: {}, eventCount: 0 });
  return await findings.create({ sessionId: id, projectId: 'p1', source: 'manual', type: 'bug', title: 'T' });
}

describe('Prometheus metrics endpoint + middleware', () => {
  let server;

  before(() => {
    delete process.env.SENTINEL_API_KEY;
    const storage = new MemoryStorageAdapter();
    const sessions = new SessionService({ storage, trace: noopTrace });
    const findings = new FindingService({ storage });
    const diagnosis = new DiagnosisService({ storage, trace: noopTrace, analyzer: noopAnalyzer, ai: noopAI, notification: noopNotification });
    const correction = new CorrectionService({ storage, ai: noopAI, analyzer: noopAnalyzer, notification: noopNotification });
    const app = createApp({ sessions, findings, diagnosis, correction, integration: null });
    server = app.listen(0);
  });

  after(() => server?.close());
  beforeEach(() => resetMetrics());

  it('exposes /metrics publicly in Prometheus format', async () => {
    const res = await makeRequest(server, 'GET', '/metrics');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /text\/plain/);
    assert.match(res.body, /# HELP sentinel_http_requests_total/);
    assert.match(res.body, /# TYPE sentinel_http_requests_total counter/);
    assert.match(res.body, /sentinel_process_/);
  });

  it('records HTTP request metrics (counter + duration histogram)', async () => {
    await makeRequest(server, 'GET', '/api/sessions/abc-xyz-123');
    const res = await makeRequest(server, 'GET', '/metrics');
    assert.equal(res.status, 200);
    assert.match(res.body, /sentinel_http_requests_total\{[^}]*method="GET"[^}]*\}\s+1/);
    assert.match(res.body, /sentinel_http_request_duration_seconds_bucket/);
  });

  it('excludes /metrics itself from HTTP metrics', async () => {
    await makeRequest(server, 'GET', '/metrics');
    await makeRequest(server, 'GET', '/metrics');
    const res = await makeRequest(server, 'GET', '/metrics');
    assert.doesNotMatch(res.body, /sentinel_http_requests_total\{[^}]*route="\/metrics"/);
  });
});

describe('FindingService — findings_created_total counter', () => {
  beforeEach(() => resetMetrics());

  it('increments with source+type labels on create', async () => {
    const storage = new MemoryStorageAdapter();
    const findings = new FindingService({ storage });
    await seedSessionFinding(storage, findings, 'f1');
    const text = await registry.metrics();
    assert.match(text, /sentinel_findings_created_total\{[^}]*source="manual"[^}]*type="bug"[^}]*\}\s+1/);
  });
});

describe('DiagnosisService — metrics instrumentation', () => {
  beforeEach(() => resetMetrics());

  it('records diagnoses_total{outcome="ai_unavailable"} when AI not configured', async () => {
    const storage = new MemoryStorageAdapter();
    const findings = new FindingService({ storage });
    const f = await seedSessionFinding(storage, findings, 'm1');

    const diag = new DiagnosisService({ storage, trace: noopTrace, analyzer: noopAnalyzer, ai: noopAI, notification: noopNotification });
    await assert.rejects(() => diag.diagnose(f.id), /not configured/i);

    const text = await registry.metrics();
    assert.match(text, /sentinel_diagnoses_total\{outcome="ai_unavailable"\}\s+1/);
  });

  it('enrichWithLiveTraces records skipped_unconfigured when adapter lacks collectLive', async () => {
    const storage = new MemoryStorageAdapter();
    const findings = new FindingService({ storage });
    const f = await seedSessionFinding(storage, findings, 'm2');

    const diag = new DiagnosisService({ storage, trace: noopTrace, analyzer: noopAnalyzer, ai: noopAI, notification: noopNotification });
    const result = await diag.enrichWithLiveTraces(f.id, { durationMs: 10 });
    assert.equal(result.skipped, 'trace-adapter-not-configured');

    const text = await registry.metrics();
    assert.match(text, /sentinel_enrich_live_total\{outcome="skipped_unconfigured"\}\s+1/);
  });

  it('enrichWithLiveTraces records collected + observes events histogram', async () => {
    const storage = new MemoryStorageAdapter();
    const findings = new FindingService({ storage });
    const f = await seedSessionFinding(storage, findings, 'm3');

    const trace = {
      isConfigured: () => true,
      getTraces: async () => [],
      collectLive: async () => [
        { type: 'http_request', ts: 1 },
        { type: 'log', ts: 2 },
        { type: 'error', ts: 3 },
      ],
    };
    const diag = new DiagnosisService({ storage, trace, analyzer: noopAnalyzer, ai: noopAI, notification: noopNotification });
    const result = await diag.enrichWithLiveTraces(f.id, { durationMs: 10 });
    assert.equal(result.added, 3);

    const text = await registry.metrics();
    assert.match(text, /sentinel_enrich_live_total\{outcome="collected"\}\s+1/);
    assert.match(text, /sentinel_enrich_live_events_collected_count\s+1/);
    assert.match(text, /sentinel_enrich_live_events_collected_sum\s+3/);
  });
});

describe('DiagnosisService — auto-enrich opt-in', () => {
  beforeEach(() => resetMetrics());
  after(() => {
    delete process.env.SENTINEL_AUTO_ENRICH;
    delete process.env.SENTINEL_AUTO_ENRICH_DURATION_MS;
  });

  it('does NOT call collectLive when SENTINEL_AUTO_ENRICH is unset', async () => {
    delete process.env.SENTINEL_AUTO_ENRICH;
    const storage = new MemoryStorageAdapter();
    const findings = new FindingService({ storage });
    const f = await seedSessionFinding(storage, findings, 'a1');

    let called = false;
    const trace = {
      isConfigured: () => true,
      getTraces: async () => [],
      collectLive: async () => { called = true; return []; },
    };
    const ai = { isConfigured: () => true, diagnose: async () => ({ rootCause: 'x', confidence: 0.5 }) };
    const diag = new DiagnosisService({ storage, trace, analyzer: noopAnalyzer, ai, notification: noopNotification });
    await diag.diagnose(f.id);

    assert.equal(called, false);
  });

  it('auto-enriches when enabled; preserves liveEvents; records collected + success', async () => {
    process.env.SENTINEL_AUTO_ENRICH = 'true';
    process.env.SENTINEL_AUTO_ENRICH_DURATION_MS = '10';
    const storage = new MemoryStorageAdapter();
    const findings = new FindingService({ storage });
    const f = await seedSessionFinding(storage, findings, 'a2');

    const trace = {
      isConfigured: () => true,
      getTraces: async () => [],
      collectLive: async () => [{ type: 'log', ts: 1 }],
    };
    const ai = { isConfigured: () => true, diagnose: async () => ({ rootCause: 'x', confidence: 0.5 }) };
    const diag = new DiagnosisService({ storage, trace, analyzer: noopAnalyzer, ai, notification: noopNotification });
    const result = await diag.diagnose(f.id);

    assert.ok(result.backendContext, 'backendContext should exist');
    assert.ok(Array.isArray(result.backendContext.liveEvents), 'liveEvents array should be merged');
    assert.equal(result.backendContext.liveEvents.length, 1);

    const text = await registry.metrics();
    assert.match(text, /sentinel_auto_enrich_total\{outcome="collected"\}\s+1/);
    assert.match(text, /sentinel_diagnoses_total\{outcome="success"\}\s+1/);
  });

  it('records auto_enrich_total{outcome="disabled"} when adapter lacks collectLive', async () => {
    process.env.SENTINEL_AUTO_ENRICH = 'true';
    const storage = new MemoryStorageAdapter();
    const findings = new FindingService({ storage });
    const f = await seedSessionFinding(storage, findings, 'a3');

    const ai = { isConfigured: () => true, diagnose: async () => ({ rootCause: 'x', confidence: 0.5 }) };
    const diag = new DiagnosisService({ storage, trace: noopTrace, analyzer: noopAnalyzer, ai, notification: noopNotification });
    await diag.diagnose(f.id);

    const text = await registry.metrics();
    assert.match(text, /sentinel_auto_enrich_total\{outcome="disabled"\}\s+1/);
  });
});
