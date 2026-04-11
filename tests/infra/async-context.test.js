// ─────────────────────────────────────────────
// Tests — AsyncLocalStorage Request Context
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  runInContext,
  getContext,
  getCorrelationId,
  getTraceEntry,
} from '../../src/core/infra/async-context.js';

describe('AsyncContext', () => {
  it('returns null outside any context', () => {
    assert.equal(getContext(), null);
    assert.equal(getCorrelationId(), null);
    assert.equal(getTraceEntry(), null);
  });

  it('provides context inside runInContext', () => {
    const entry = { queries: [] };
    const ctx = { correlationId: 'c-1', sessionId: 's-1', traceEntry: entry };

    runInContext(ctx, () => {
      assert.deepEqual(getContext(), ctx);
      assert.equal(getCorrelationId(), 'c-1');
      assert.equal(getTraceEntry(), entry);
    });
  });

  it('context is isolated after runInContext completes', () => {
    runInContext({ correlationId: 'tmp' }, () => {
      assert.equal(getCorrelationId(), 'tmp');
    });
    // Outside the callback, context should be gone
    assert.equal(getContext(), null);
  });

  it('supports nested contexts (inner overrides outer)', () => {
    runInContext({ correlationId: 'outer' }, () => {
      assert.equal(getCorrelationId(), 'outer');

      runInContext({ correlationId: 'inner' }, () => {
        assert.equal(getCorrelationId(), 'inner');
      });

      // Back to outer after inner completes
      assert.equal(getCorrelationId(), 'outer');
    });
  });

  it('propagates through async operations', async () => {
    const result = await new Promise((resolve) => {
      runInContext({ correlationId: 'async-test', traceEntry: { queries: [] } }, () => {
        // Simulate async work
        setTimeout(() => {
          resolve(getCorrelationId());
        }, 10);
      });
    });

    assert.equal(result, 'async-test');
  });

  it('isolates concurrent requests — the critical race condition fix', async () => {
    // Simulate two concurrent requests running in parallel
    const results = await Promise.all([
      new Promise((resolve) => {
        runInContext({ correlationId: 'req-A', traceEntry: { queries: [] } }, () => {
          // Simulate slow I/O — the other request runs during this delay
          setTimeout(() => {
            const entry = getTraceEntry();
            entry.queries.push('SELECT FROM A');
            resolve({ id: getCorrelationId(), queries: entry.queries });
          }, 20);
        });
      }),
      new Promise((resolve) => {
        runInContext({ correlationId: 'req-B', traceEntry: { queries: [] } }, () => {
          setTimeout(() => {
            const entry = getTraceEntry();
            entry.queries.push('SELECT FROM B');
            resolve({ id: getCorrelationId(), queries: entry.queries });
          }, 10); // B finishes before A
        });
      }),
    ]);

    // Each request should have its own correlation and queries
    const [resultA, resultB] = results;
    assert.equal(resultA.id, 'req-A');
    assert.deepEqual(resultA.queries, ['SELECT FROM A']);
    assert.equal(resultB.id, 'req-B');
    assert.deepEqual(resultB.queries, ['SELECT FROM B']);
  });

  it('traceEntry mutation is isolated per context', () => {
    const entryA = { queries: [] };
    const entryB = { queries: [] };

    runInContext({ correlationId: 'a', traceEntry: entryA }, () => {
      getTraceEntry().queries.push('query-a');
    });

    runInContext({ correlationId: 'b', traceEntry: entryB }, () => {
      getTraceEntry().queries.push('query-b');
    });

    assert.deepEqual(entryA.queries, ['query-a']);
    assert.deepEqual(entryB.queries, ['query-b']);
  });
});
