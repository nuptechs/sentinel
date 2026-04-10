// ─────────────────────────────────────────────
// Sentinel — Data Retention Cleanup Job
// Periodically removes old sessions, events, and
// findings to prevent unbounded storage growth.
// ─────────────────────────────────────────────

/**
 * RetentionJob runs on a configurable interval and removes:
 *   - Completed/expired sessions older than retentionDays
 *   - Events older than eventRetentionDays (may differ from session retention)
 *   - Dismissed findings older than retentionDays
 *
 * CASCADE on sentinel_events means deleting a session removes its events.
 * Findings also CASCADE from sessions.
 *
 * Usage (in container or server startup):
 *   const job = new RetentionJob({ pool, retentionDays: 30 });
 *   job.start();
 *   // On shutdown:
 *   job.stop();
 */
export class RetentionJob {
  /**
   * @param {object} options
   * @param {import('pg').Pool} options.pool
   * @param {number} [options.retentionDays=30] — days to keep completed sessions
   * @param {number} [options.eventRetentionDays=14] — days to keep orphan events
   * @param {number} [options.intervalMs=3600000] — cleanup interval (default: 1h)
   * @param {number} [options.batchSize=500] — max rows to delete per batch
   */
  constructor({
    pool,
    retentionDays = 30,
    eventRetentionDays = 14,
    intervalMs = 60 * 60 * 1000,
    batchSize = 500,
  }) {
    this.pool = pool;
    this.retentionDays = retentionDays;
    this.eventRetentionDays = eventRetentionDays;
    this.intervalMs = intervalMs;
    this.batchSize = batchSize;
    this._timer = null;
    this._running = false;
  }

  /**
   * Start the periodic cleanup timer.
   * Runs an initial cleanup immediately.
   */
  start() {
    if (this._timer) return;

    // Run first cleanup after a short delay (let server boot)
    setTimeout(() => this.run(), 10_000);

    this._timer = setInterval(() => this.run(), this.intervalMs);
    console.log(`[Sentinel] Retention job started: sessions=${this.retentionDays}d, events=${this.eventRetentionDays}d, interval=${this.intervalMs / 1000}s`);
  }

  /** Stop the cleanup timer. */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Run one cleanup cycle.
   * Safe to call manually (e.g. from an admin endpoint).
   */
  async run() {
    if (this._running) return; // prevent overlap
    this._running = true;

    const stats = { sessions: 0, events: 0, findings: 0 };

    try {
      // 1. Delete old completed/expired sessions (CASCADE deletes their events + findings)
      const sessionResult = await this.pool.query(
        `DELETE FROM sentinel_sessions
         WHERE id IN (
           SELECT id FROM sentinel_sessions
           WHERE status IN ('completed', 'expired')
             AND updated_at < NOW() - $1::interval
           LIMIT $2
         )`,
        [`${this.retentionDays} days`, this.batchSize]
      );
      stats.sessions = sessionResult.rowCount || 0;

      // 2. Delete old events from still-active sessions (prevent event bloat)
      const eventResult = await this.pool.query(
        `DELETE FROM sentinel_events
         WHERE id IN (
           SELECT id FROM sentinel_events
           WHERE created_at < NOW() - $1::interval
           LIMIT $2
         )`,
        [`${this.eventRetentionDays} days`, this.batchSize]
      );
      stats.events = eventResult.rowCount || 0;

      // 3. Delete old dismissed findings
      const findingResult = await this.pool.query(
        `DELETE FROM sentinel_findings
         WHERE id IN (
           SELECT id FROM sentinel_findings
           WHERE status = 'dismissed'
             AND updated_at < NOW() - $1::interval
           LIMIT $2
         )`,
        [`${this.retentionDays} days`, this.batchSize]
      );
      stats.findings = findingResult.rowCount || 0;

      if (stats.sessions > 0 || stats.events > 0 || stats.findings > 0) {
        console.log(`[Sentinel] Retention cleanup: ${stats.sessions} sessions, ${stats.events} events, ${stats.findings} findings removed`);
      }
    } catch (err) {
      console.error('[Sentinel] Retention cleanup error:', err.message);
    } finally {
      this._running = false;
    }

    return stats;
  }
}
