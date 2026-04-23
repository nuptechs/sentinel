// ─────────────────────────────────────────────
// Tests — runMigrations (unit, no real DB)
// Uses mock pools to cover the "schema is up
// to date" log and the ROLLBACK + rethrow path
// without requiring a PostgreSQL connection.
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMigrations } from '../../src/adapters/storage/migrations.js';

// ── Mock pool helpers ────────────────────────

/**
 * All migrations already applied (version 1 in control table).
 * pool.connect() must never be called — no migration SQL runs.
 * count stays 0 → triggers the "schema is up to date" log line.
 */
function makeAllAppliedPool() {
  let queryCount = 0;
  return {
    async query(_sql) {
      queryCount++;
      if (queryCount === 2) {
        // Second call: SELECT version FROM sentinel_migrations
        // Return ALL known migration versions so the runner has nothing to do.
        return { rows: [{ version: 1 }, { version: 2 }] };
      }
      return { rows: [] };
    },
    async connect() {
      throw new Error('connect() must not be called when all migrations are already applied');
    },
  };
}

/**
 * No migrations applied yet, but the migration SQL throws.
 * Exercises: client.query('BEGIN'), SQL throw, ROLLBACK, release(), rethrow.
 */
function makeFailingMigrationPool() {
  let clientCallCount = 0;
  return {
    async query(_sql) {
      // pool.query: BOOTSTRAP_SQL and SELECT version both succeed
      return { rows: [] }; // empty applied set → version 1 will be attempted
    },
    async connect() {
      return {
        async query(sql) {
          clientCallCount++;
          // ROLLBACK must succeed so the finally-release path is covered correctly
          if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') {
            return { rows: [] };
          }
          // Second client call is migration.sql — make it fail
          if (clientCallCount === 2) {
            throw new Error('permission denied for schema');
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
}

// ── Tests ─────────────────────────────────────

describe('runMigrations (unit)', () => {
  it('returns 0 when all migrations are already applied', async () => {
    const pool = makeAllAppliedPool();
    const count = await runMigrations(pool);
    assert.equal(count, 0);
  });

  it('calls ROLLBACK and rethrows a labelled error when migration SQL fails', async () => {
    let rollbackCalled = false;

    const pool = makeFailingMigrationPool();
    // Intercept connect() to track ROLLBACK
    const originalConnect = pool.connect.bind(pool);
    pool.connect = async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      client.query = async (sql) => {
        if (typeof sql === 'string' && sql.trim().toUpperCase() === 'ROLLBACK') {
          rollbackCalled = true;
        }
        return originalQuery(sql);
      };
      return client;
    };

    await assert.rejects(
      () => runMigrations(pool),
      (err) => {
        assert.ok(
          err.message.includes('[Sentinel] Migration v1'),
          `Expected labelled error, got: ${err.message}`,
        );
        assert.ok(
          err.message.includes('failed'),
          `Expected "failed" in error, got: ${err.message}`,
        );
        return true;
      },
    );

    assert.ok(rollbackCalled, 'ROLLBACK must be issued after a migration failure');
  });
});
