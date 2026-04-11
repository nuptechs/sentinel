// ─────────────────────────────────────────────
// Tests — CircuitBreaker
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError, TimeoutError } from '../../src/core/infra/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker({
      name: 'test',
      failureThreshold: 3,
      windowMs: 60_000,
      recoveryMs: 100, // short for testing
      halfOpenMax: 1,
    });
  });

  describe('CLOSED state', () => {
    it('starts in CLOSED state', () => {
      assert.equal(breaker.state, 'CLOSED');
    });

    it('passes successful calls through', async () => {
      const result = await breaker.fire(() => Promise.resolve(42));
      assert.equal(result, 42);
      assert.equal(breaker.metrics.totalCalls, 1);
      assert.equal(breaker.metrics.totalSuccess, 1);
    });

    it('propagates errors without opening if below threshold', async () => {
      await assert.rejects(() => breaker.fire(() => Promise.reject(new Error('fail-1'))));
      await assert.rejects(() => breaker.fire(() => Promise.reject(new Error('fail-2'))));
      assert.equal(breaker.state, 'CLOSED');
      assert.equal(breaker.metrics.totalFailure, 2);
    });

    it('transitions to OPEN after reaching failure threshold', async () => {
      for (let i = 0; i < 3; i++) {
        await assert.rejects(() => breaker.fire(() => Promise.reject(new Error(`fail-${i}`))));
      }
      assert.equal(breaker.state, 'OPEN');
    });

    it('counts failures within sliding window only', async () => {
      // Manually inject old failures outside the window
      breaker._failures = [Date.now() - 120_000, Date.now() - 90_000];
      // These are outside the 60s window, so only 1 new failure should count
      await assert.rejects(() => breaker.fire(() => Promise.reject(new Error('recent'))));
      assert.equal(breaker.state, 'CLOSED'); // 1 recent failure < threshold of 3
    });
  });

  describe('OPEN state', () => {
    async function tripBreaker(b) {
      for (let i = 0; i < 3; i++) {
        await b.fire(() => Promise.reject(new Error(`trip-${i}`))).catch(() => {});
      }
    }

    it('rejects calls immediately with CircuitOpenError', async () => {
      await tripBreaker(breaker);
      assert.equal(breaker.state, 'OPEN');

      await assert.rejects(
        () => breaker.fire(() => Promise.resolve('should not run')),
        (err) => {
          assert.ok(err instanceof CircuitOpenError);
          assert.ok(err.isCircuitOpen);
          assert.equal(err.name, 'CircuitOpenError');
          return true;
        }
      );
      assert.equal(breaker.metrics.totalRejected, 1);
    });

    it('returns fallback value when provided', async () => {
      await tripBreaker(breaker);
      const result = await breaker.fire(
        () => Promise.resolve('should not run'),
        'fallback-value'
      );
      assert.equal(result, 'fallback-value');
      assert.equal(breaker.metrics.totalRejected, 1);
    });

    it('transitions to HALF_OPEN after recovery period', async () => {
      await tripBreaker(breaker);
      assert.equal(breaker.state, 'OPEN');

      // Wait for recovery period (100ms)
      await new Promise(r => setTimeout(r, 120));

      // getStatus triggers _maybeTransition
      const status = breaker.getStatus();
      assert.equal(status.state, 'HALF_OPEN');
    });
  });

  describe('HALF_OPEN state', () => {
    async function tripAndWait(b) {
      for (let i = 0; i < 3; i++) {
        await b.fire(() => Promise.reject(new Error(`trip-${i}`))).catch(() => {});
      }
      await new Promise(r => setTimeout(r, 120));
    }

    it('transitions to CLOSED on success', async () => {
      await tripAndWait(breaker);
      breaker._maybeTransition();
      assert.equal(breaker.state, 'HALF_OPEN');

      const result = await breaker.fire(() => Promise.resolve('recovered'));
      assert.equal(result, 'recovered');
      assert.equal(breaker.state, 'CLOSED');
    });

    it('transitions back to OPEN on failure', async () => {
      await tripAndWait(breaker);
      breaker._maybeTransition();
      assert.equal(breaker.state, 'HALF_OPEN');

      await assert.rejects(() => breaker.fire(() => Promise.reject(new Error('still broken'))));
      assert.equal(breaker.state, 'OPEN');
    });

    it('limits concurrent probes to halfOpenMax', async () => {
      await tripAndWait(breaker);
      breaker._maybeTransition();
      assert.equal(breaker.state, 'HALF_OPEN');

      // First call is the probe — create a slow one that doesn't resolve yet
      let resolveProbe;
      const probePromise = breaker.fire(() => new Promise(r => { resolveProbe = r; }));

      // Second call should be rejected (only 1 probe allowed)
      await assert.rejects(
        () => breaker.fire(() => Promise.resolve('blocked')),
        (err) => err instanceof CircuitOpenError
      );

      // Complete the probe
      resolveProbe('ok');
      await probePromise;
    });
  });

  describe('isFailure predicate', () => {
    it('does not count non-failures toward threshold', async () => {
      const b = new CircuitBreaker({
        name: 'selective',
        failureThreshold: 2,
        recoveryMs: 100,
        isFailure: (err) => err.status !== 404,
      });

      // 404 errors should not trip the breaker
      const err404 = new Error('not found');
      err404.status = 404;

      for (let i = 0; i < 5; i++) {
        await assert.rejects(() => b.fire(() => Promise.reject(err404)));
      }
      assert.equal(b.state, 'CLOSED'); // 404s don't count

      // 500 errors should trip it
      const err500 = new Error('server error');
      err500.status = 500;

      await assert.rejects(() => b.fire(() => Promise.reject(err500)));
      await assert.rejects(() => b.fire(() => Promise.reject(err500)));
      assert.equal(b.state, 'OPEN');
    });
  });

  describe('timeout', () => {
    it('rejects slow calls with TimeoutError', async () => {
      const b = new CircuitBreaker({
        name: 'timeout-test',
        failureThreshold: 5,
        timeoutMs: 50,
      });

      await assert.rejects(
        () => b.fire(() => new Promise(r => setTimeout(r, 200))),
        (err) => {
          assert.ok(err instanceof TimeoutError);
          assert.equal(err.timeoutMs, 50);
          return true;
        }
      );
      assert.equal(b.metrics.totalTimeout, 1);
    });
  });

  describe('onStateChange callback', () => {
    it('fires on state transitions', async () => {
      const transitions = [];
      const b = new CircuitBreaker({
        name: 'events',
        failureThreshold: 1,
        recoveryMs: 50,
        onStateChange: (from, to) => transitions.push(`${from}->${to}`),
      });

      await b.fire(() => Promise.reject(new Error('trip'))).catch(() => {});
      assert.deepEqual(transitions, ['CLOSED->OPEN']);

      await new Promise(r => setTimeout(r, 60));
      b.getStatus(); // triggers transition
      assert.deepEqual(transitions, ['CLOSED->OPEN', 'OPEN->HALF_OPEN']);
    });
  });

  describe('reset', () => {
    it('resets breaker to CLOSED', async () => {
      for (let i = 0; i < 3; i++) {
        await breaker.fire(() => Promise.reject(new Error(`trip-${i}`))).catch(() => {});
      }
      assert.equal(breaker.state, 'OPEN');

      breaker.reset();
      assert.equal(breaker.state, 'CLOSED');

      // Should work immediately after reset
      const result = await breaker.fire(() => Promise.resolve('back'));
      assert.equal(result, 'back');
    });
  });

  describe('getStatus', () => {
    it('returns complete status info', () => {
      const status = breaker.getStatus();
      assert.equal(status.name, 'test');
      assert.equal(status.state, 'CLOSED');
      assert.equal(status.failures, 0);
      assert.equal(status.threshold, 3);
      assert.equal(typeof status.metrics, 'object');
      assert.equal(status.metrics.totalCalls, 0);
    });
  });

  describe('metrics', () => {
    it('tracks all counters accurately', async () => {
      await breaker.fire(() => Promise.resolve(1));
      await breaker.fire(() => Promise.resolve(2));
      await breaker.fire(() => Promise.reject(new Error('e1'))).catch(() => {});

      assert.equal(breaker.metrics.totalCalls, 3);
      assert.equal(breaker.metrics.totalSuccess, 2);
      assert.equal(breaker.metrics.totalFailure, 1);
      assert.ok(breaker.metrics.lastSuccessAt);
      assert.ok(breaker.metrics.lastFailureAt);
    });
  });
});
