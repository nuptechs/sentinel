// ─────────────────────────────────────────────
// Sentinel — Container (DI)
// Wires ports → adapters → services based on env
// Single source of truth for the dependency graph
// ─────────────────────────────────────────────

import { PostgresStorageAdapter } from './adapters/storage/postgres.adapter.js';
import { MemoryStorageAdapter } from './adapters/storage/memory.adapter.js';
import { ManifestAnalyzerAdapter } from './adapters/analyzer/manifest.adapter.js';
import { NoopAnalyzerAdapter } from './adapters/analyzer/noop.adapter.js';
import { ClaudeAIAdapter } from './adapters/ai/claude.adapter.js';
import { NoopTraceAdapter } from './adapters/trace/noop.adapter.js';
import { DebugProbeTraceAdapter } from './adapters/trace/debugprobe.adapter.js';
import { WebhookNotificationAdapter } from './adapters/notification/webhook.adapter.js';
import { NoopNotificationAdapter } from './adapters/notification/noop.adapter.js';

import { SessionService } from './core/services/session.service.js';
import { FindingService } from './core/services/finding.service.js';
import { DiagnosisService } from './core/services/diagnosis.service.js';
import { CorrectionService } from './core/services/correction.service.js';

let _container = null;

/**
 * Create and return the singleton container.
 * Must be awaited on first call (async adapter construction).
 * Subsequent calls return the cached instance synchronously.
 *
 * Adapter selection is driven entirely by environment variables.
 *
 * Required:
 *   DATABASE_URL or SENTINEL_MEMORY_STORAGE=true
 *
 * Optional:
 *   MANIFEST_URL        → Manifest analyzer adapter
 *   MANIFEST_API_KEY    → Manifest auth
 *   ANTHROPIC_API_KEY   → Claude AI adapter
 *   WEBHOOK_URL         → Webhook notification adapter
 *   WEBHOOK_SECRET      → HMAC signature for webhooks
 */
export async function getContainer() {
  if (!_container) {
    const adapters = await buildAdapters();
    const services = buildServices(adapters);

    _container = Object.freeze({
      adapters: Object.freeze(adapters),
      services: Object.freeze(services),
    });
  }
  return _container;
}

export function resetContainer() {
  _container = null;
}

/**
 * Initialize all adapters that require setup (e.g. DB schema).
 */
export async function initializeContainer() {
  const { adapters } = await getContainer();
  await adapters.storage.initialize();
  console.log('[Sentinel] Container initialized');
}

/**
 * Graceful shutdown — flush and close adapters.
 */
export async function shutdownContainer() {
  if (!_container) return;
  const { adapters } = _container;
  await adapters.storage.close().catch(() => {});
  _container = null;
  console.log('[Sentinel] Container shut down');
}

// ── Builder functions ─────────────────────────

async function buildAdapters() {
  return {
    storage: await buildStorage(),
    trace: buildTrace(),
    analyzer: buildAnalyzer(),
    ai: buildAI(),
    notification: buildNotification(),
  };
}

function buildServices(adapters) {
  return {
    sessions: new SessionService({ storage: adapters.storage }),
    findings: new FindingService({ storage: adapters.storage }),
    diagnosis: new DiagnosisService({
      storage: adapters.storage,
      trace: adapters.trace,
      analyzer: adapters.analyzer,
      ai: adapters.ai,
      notification: adapters.notification,
    }),
    correction: new CorrectionService({
      storage: adapters.storage,
      analyzer: adapters.analyzer,
      ai: adapters.ai,
      notification: adapters.notification,
    }),
  };
}

async function buildStorage() {
  if (process.env.SENTINEL_MEMORY_STORAGE === 'true') {
    console.log('[Sentinel] Storage: in-memory');
    return new MemoryStorageAdapter();
  }

  const url = process.env.DATABASE_URL;
  if (url) {
    const pg = await import('pg');
    const Pool = pg.default?.Pool ?? pg.Pool;
    const pool = new Pool({
      connectionString: url,
      max: parseInt(process.env.SENTINEL_DB_POOL_MAX || '10', 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    // Retry connection up to 5 times (Postgres may still be starting)
    const maxRetries = parseInt(process.env.SENTINEL_DB_RETRIES || '5', 10);
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const client = await pool.connect();
        client.release();
        console.log('[Sentinel] Storage: PostgreSQL (connected)');
        return new PostgresStorageAdapter({ pool });
      } catch (err) {
        console.warn(`[Sentinel] Postgres connection attempt ${attempt}/${maxRetries} failed: ${err.message}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, attempt * 2000));
        }
      }
    }

    // All retries failed — fall back to in-memory
    console.error('[Sentinel] Postgres unavailable after retries — falling back to in-memory');
    await pool.end().catch(() => {});
    return new MemoryStorageAdapter();
  }

  console.log('[Sentinel] Storage: in-memory (no DATABASE_URL)');
  return new MemoryStorageAdapter();
}

function buildTrace() {
  const traceMode = process.env.SENTINEL_TRACE;
  const traceBaseUrl = process.env.SENTINEL_TRACE_URL || process.env.DEBUG_PROBE_URL || process.env.PROBE_SERVER_URL || null;

  if (traceMode === 'debugprobe' || traceBaseUrl) {
    const maxTraces = parseInt(process.env.SENTINEL_TRACE_MAX || '10000', 10);
    console.log(`[Sentinel] Trace: DebugProbe${traceBaseUrl ? ` → ${traceBaseUrl}` : ''} (max=${maxTraces})`);
    return new DebugProbeTraceAdapter({
      maxTraces,
      baseUrl: traceBaseUrl,
      apiKey: process.env.SENTINEL_TRACE_API_KEY || process.env.PROBE_API_KEY || null,
    });
  }
  return new NoopTraceAdapter();
}

function buildAnalyzer() {
  const url = process.env.MANIFEST_URL;
  if (url) {
    console.log(`[Sentinel] Analyzer: Manifest → ${url}`);
    return new ManifestAnalyzerAdapter({
      baseUrl: url,
      apiKey: process.env.MANIFEST_API_KEY,
    });
  }
  return new NoopAnalyzerAdapter();
}

function buildAI() {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log('[Sentinel] AI: Claude');
    return new ClaudeAIAdapter({
      model: process.env.SENTINEL_AI_MODEL || 'claude-sonnet-4-20250514',
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  console.warn('[Sentinel] AI: NOT configured — diagnosis unavailable');
  return { isConfigured: () => false };
}

function buildNotification() {
  const url = process.env.WEBHOOK_URL;
  if (url) {
    console.log(`[Sentinel] Notification: Webhook → ${url}`);
    return new WebhookNotificationAdapter({
      url,
      secret: process.env.WEBHOOK_SECRET,
    });
  }
  return new NoopNotificationAdapter();
}
