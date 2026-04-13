// ─────────────────────────────────────────────
// Sentinel — PostgreSQL Migration Runner
// Sequential, versioned schema migrations with
// a control table (sentinel_migrations).
//
// Each migration runs once. Rollback is manual.
// Add new migrations to the MIGRATIONS array.
// ─────────────────────────────────────────────

/**
 * @typedef {Object} Migration
 * @property {number} version — sequential integer (never reuse)
 * @property {string} name — human-readable label
 * @property {string} sql — DDL/DML to run (may contain multiple statements)
 */

/** @type {Migration[]} */
const MIGRATIONS = [
  {
    version: 1,
    name: 'initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS sentinel_sessions (
        id            UUID PRIMARY KEY,
        project_id    TEXT NOT NULL,
        user_id       TEXT,
        user_agent    TEXT,
        page_url      TEXT,
        status        TEXT NOT NULL DEFAULT 'active',
        metadata      JSONB DEFAULT '{}',
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at  TIMESTAMPTZ
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_sessions_project
        ON sentinel_sessions (project_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS sentinel_events (
        id              UUID PRIMARY KEY,
        session_id      UUID NOT NULL REFERENCES sentinel_sessions(id) ON DELETE CASCADE,
        type            TEXT NOT NULL,
        source          TEXT NOT NULL,
        timestamp       BIGINT NOT NULL,
        payload         JSONB NOT NULL,
        correlation_id  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_events_session
        ON sentinel_events (session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_sentinel_events_correlation
        ON sentinel_events (correlation_id) WHERE correlation_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sentinel_findings (
        id               UUID PRIMARY KEY,
        session_id       UUID NOT NULL REFERENCES sentinel_sessions(id) ON DELETE CASCADE,
        project_id       TEXT NOT NULL,
        source           TEXT NOT NULL,
        type             TEXT NOT NULL,
        severity         TEXT NOT NULL DEFAULT 'medium',
        status           TEXT NOT NULL DEFAULT 'open',
        title            TEXT NOT NULL,
        description      TEXT,
        page_url         TEXT,
        css_selector     TEXT,
        screenshot_url   TEXT,
        annotation       JSONB,
        browser_context  JSONB,
        backend_context  JSONB,
        code_context     JSONB,
        diagnosis        JSONB,
        correction       JSONB,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_session
        ON sentinel_findings (session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sentinel_findings_project
        ON sentinel_findings (project_id, status, created_at DESC);

      CREATE TABLE IF NOT EXISTS sentinel_traces (
        id              BIGSERIAL PRIMARY KEY,
        session_id      TEXT NOT NULL,
        correlation_id  TEXT NOT NULL,
        trace_id        TEXT,
        span_id         TEXT,
        request         JSONB,
        response        JSONB,
        queries         JSONB DEFAULT '[]',
        duration_ms     DOUBLE PRECISION,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_sentinel_traces_correlation
        ON sentinel_traces (correlation_id);
      CREATE INDEX IF NOT EXISTS idx_sentinel_traces_session
        ON sentinel_traces (session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sentinel_traces_created
        ON sentinel_traces (created_at);
    `,
  },

  // ── Future migrations go here ─────────────
  // {
  //   version: 2,
  //   name: 'add_finding_tags',
  //   sql: `ALTER TABLE sentinel_findings ADD COLUMN tags TEXT[] DEFAULT '{}';`,
  // },
];

/**
 * Ensure the migrations control table exists.
 * This is the only `CREATE TABLE IF NOT EXISTS` that runs every boot.
 */
const BOOTSTRAP_SQL = `
  CREATE TABLE IF NOT EXISTS sentinel_migrations (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

/**
 * Run all pending migrations inside individual transactions.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<number>} — count of newly applied migrations
 */
export async function runMigrations(pool) {
  // 1. Bootstrap the control table
  await pool.query(BOOTSTRAP_SQL);

  // 2. Read already-applied versions
  const { rows } = await pool.query(
    'SELECT version FROM sentinel_migrations ORDER BY version'
  );
  const applied = new Set(rows.map(r => r.version));

  // 3. Run pending migrations in order
  let count = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO sentinel_migrations (version, name) VALUES ($1, $2)',
        [migration.version, migration.name]
      );
      await client.query('COMMIT');
      console.log(`[Sentinel] Migration v${migration.version} applied: ${migration.name}`);
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `[Sentinel] Migration v${migration.version} (${migration.name}) failed: ${err.message}`
      );
    } finally {
      client.release();
    }
  }

  if (count === 0) {
    console.log('[Sentinel] Migrations: schema is up to date');
  }

  return count;
}
