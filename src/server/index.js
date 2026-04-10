// ─────────────────────────────────────────────
// Sentinel — Server entrypoint
// ─────────────────────────────────────────────

import { createApp } from './app.js';
import { initializeContainer, shutdownContainer, getContainer } from '../container.js';
import { RetentionJob } from '../core/retention.js';

const PORT = parseInt(process.env.PORT || '3900', 10);

let retentionJob = null;

async function main() {
  console.log('[Sentinel] Starting...');

  // Build and initialize the container (async — pg import, DB schema)
  await initializeContainer();
  const { services, adapters } = await getContainer();

  // Create Express app
  const app = createApp(services);

  // Start data retention cleanup (PostgreSQL only)
  if (adapters.storage.pool) {
    retentionJob = new RetentionJob({
      pool: adapters.storage.pool,
      retentionDays: parseInt(process.env.SENTINEL_RETENTION_DAYS || '30', 10),
      eventRetentionDays: parseInt(process.env.SENTINEL_EVENT_RETENTION_DAYS || '14', 10),
    });
    retentionJob.start();
  }

  const server = app.listen(PORT, () => {
    console.log(`[Sentinel] Listening on http://localhost:${PORT}`);
    console.log(`[Sentinel] Health: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[Sentinel] ${signal} received — shutting down...`);
    if (retentionJob) retentionJob.stop();
    server.close(async () => {
      await shutdownContainer();
      process.exit(0);
    });

    // Force exit after 10s
    setTimeout(() => {
      console.error('[Sentinel] Forced shutdown after timeout');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[Sentinel] Fatal error during startup:', err);
  process.exit(1);
});
