// ─────────────────────────────────────────────
// Sentinel — Core Service: DiagnosisService
// Orchestrates: enrich finding → resolve code → AI diagnose
// Depends ONLY on ports — zero external imports
// ─────────────────────────────────────────────

import { NotFoundError, IntegrationError } from '../errors.js';
import {
  diagnosesTotal,
  diagnosisDuration,
  enrichLiveTotal,
  enrichLiveEventsCollected,
  autoEnrichTotal,
} from '../../observability/metrics.js';

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class DiagnosisService {
  /**
   * @param {object} ports
   * @param {import('../ports/storage.port.js').StoragePort}   ports.storage
   * @param {import('../ports/trace.port.js').TracePort}       ports.trace
   * @param {import('../ports/analyzer.port.js').AnalyzerPort} ports.analyzer
   * @param {import('../ports/ai.port.js').AIPort}             ports.ai
   * @param {import('../ports/notification.port.js').NotificationPort} [ports.notification]
   */
  constructor({ storage, trace, analyzer, ai, notification }) {
    this.storage = storage;
    this.trace = trace;
    this.analyzer = analyzer;
    this.ai = ai;
    this.notification = notification || null;
  }

  /**
   * Full diagnosis pipeline for a finding:
   * 1. Enrich with backend traces (if TracePort configured)
   * 2. Resolve code chain (if AnalyzerPort configured)
   * 3. AI diagnosis
   * 4. Notify
   */
  async diagnose(findingId) {
    const startNs = process.hrtime.bigint();
    let outcome = 'success';
    try {
      const finding = await this.storage.getFinding(findingId);
      if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);

      // Step 0 (opt-in): Auto-enrich with live traces before static enrichment.
      // Controlled by SENTINEL_AUTO_ENRICH=true. Window defaults to 1500ms.
      if (process.env.SENTINEL_AUTO_ENRICH === 'true') {
        if (this.trace && typeof this.trace.collectLive === 'function' && this.trace.isConfigured?.()) {
          const durationMs = parsePositiveInt(process.env.SENTINEL_AUTO_ENRICH_DURATION_MS, 1500);
          const limit = parsePositiveInt(process.env.SENTINEL_AUTO_ENRICH_LIMIT, 50);
          try {
            const events = await this.trace.collectLive(finding.sessionId, { durationMs, limit });
            if (Array.isArray(events) && events.length > 0) {
              const prev = finding.backendContext || {};
              const existing = Array.isArray(prev.liveEvents) ? prev.liveEvents : [];
              finding.attachBackendContext({ ...prev, liveEvents: existing.concat(events) });
              autoEnrichTotal.inc({ outcome: 'collected' });
            } else {
              autoEnrichTotal.inc({ outcome: 'skipped' });
            }
          } catch (err) {
            autoEnrichTotal.inc({ outcome: 'failed' });
            console.warn(`[Sentinel] Auto-enrich failed for finding ${findingId}:`, err.message);
          }
        } else {
          autoEnrichTotal.inc({ outcome: 'disabled' });
        }
      }

      // Step 1: Enrich with backend traces
    if (this.trace?.isConfigured()) {
      try {
        const traces = await this.trace.getTraces(finding.sessionId, {
          since: finding.createdAt,
        });
        // Merge to preserve any liveEvents attached by auto-enrich (Step 0).
        const prevCtx = finding.backendContext || {};
        finding.attachBackendContext({ ...prevCtx, traces });
      } catch (err) {
        console.warn(`[Sentinel] Trace enrichment failed for finding ${findingId}:`, err.message);
      }
    }

    // Step 2: Resolve code via static analyzer
    if (this.analyzer?.isConfigured() && finding.backendContext?.traces?.length) {
      try {
        const endpoints = this._extractEndpoints(finding.backendContext.traces);
        const codeChains = [];

        for (const ep of endpoints) {
          const chain = await this.analyzer.resolveEndpoint(finding.projectId, ep.endpoint, ep.method);
          if (chain) codeChains.push(chain);
        }

        if (codeChains.length > 0) {
          finding.attachCodeContext({
            endpoints: codeChains,
            resolvedAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.warn(`[Sentinel] Code resolution failed for finding ${findingId}:`, err.message);
      }
    }

    // Step 3: AI diagnosis
    if (!this.ai?.isConfigured()) {
      throw new IntegrationError('AI adapter not configured — cannot diagnose');
    }

    const sourceFiles = {};
    if (finding.codeContext?.endpoints) {
      for (const chain of finding.codeContext.endpoints) {
        if (chain.sourceFiles) {
          for (const file of chain.sourceFiles) {
            try {
              const content = await this.analyzer.getSourceFile(finding.projectId, file);
              if (content) sourceFiles[file] = content;
            } catch { /* skip unreadable files */ }
          }
        }
      }
    }

    const diagnosis = await this.ai.diagnose({
      finding: finding.toJSON(),
      traces: finding.backendContext,
      codeChain: finding.codeContext,
      sourceFiles,
    });

    finding.diagnose(diagnosis);
    await this.storage.updateFinding(finding);

    // Step 4: Notify
    if (this.notification?.isConfigured()) {
      await this.notification.onDiagnosisReady(finding).catch(err =>
        console.warn(`[Sentinel] Notification failed:`, err.message)
      );
    }

    return finding;
    } catch (err) {
      outcome = err instanceof IntegrationError && /not configured/i.test(err.message)
        ? 'ai_unavailable'
        : 'failed';
      throw err;
    } finally {
      const durationSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      diagnosesTotal.inc({ outcome });
      diagnosisDuration.observe({ outcome }, durationSec);
    }
  }

  /**
   * Enrich a finding with realtime trace events collected from the
   * backing TracePort (e.g. Debug Probe WebSocket). Independent of
   * `diagnose()` — merges events into `backendContext.liveEvents`.
   *
   * @param {string} findingId
   * @param {{durationMs?:number, limit?:number}} [options]
   * @returns {Promise<{findingId:string, added:number, total:number, skipped?:string}>}
   */
  async enrichWithLiveTraces(findingId, options = {}) {
    const finding = await this.storage.getFinding(findingId);
    if (!finding) {
      enrichLiveTotal.inc({ outcome: 'not_found' });
      throw new NotFoundError(`Finding ${findingId} not found`);
    }

    if (!this.trace || typeof this.trace.collectLive !== 'function' || !this.trace.isConfigured?.()) {
      enrichLiveTotal.inc({ outcome: 'skipped_unconfigured' });
      return { findingId, added: 0, total: 0, skipped: 'trace-adapter-not-configured' };
    }

    let events = [];
    try {
      events = await this.trace.collectLive(finding.sessionId, options);
    } catch (err) {
      enrichLiveTotal.inc({ outcome: 'skipped_failed' });
      console.warn(`[Sentinel] Live trace collection failed for ${findingId}:`, err.message);
      return { findingId, added: 0, total: 0, skipped: 'collect-failed' };
    }

    const prev = finding.backendContext || {};
    const existing = Array.isArray(prev.liveEvents) ? prev.liveEvents : [];
    const merged = existing.concat(events);

    finding.attachBackendContext({ ...prev, liveEvents: merged });
    await this.storage.updateFinding(finding);

    enrichLiveTotal.inc({ outcome: 'collected' });
    enrichLiveEventsCollected.observe(events.length);

    return { findingId, added: events.length, total: merged.length };
  }

  _extractEndpoints(traces) {
    const seen = new Set();
    const endpoints = [];
    for (const trace of traces) {
      if (trace.type === 'http_request' && trace.payload?.path && trace.payload?.method) {
        const key = `${trace.payload.method}:${trace.payload.path}`;
        if (!seen.has(key)) {
          seen.add(key);
          endpoints.push({ endpoint: trace.payload.path, method: trace.payload.method });
        }
      }
    }
    return endpoints;
  }
}
