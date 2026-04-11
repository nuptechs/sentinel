// ─────────────────────────────────────────────
// Tests — W3C Trace Context
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTraceparent,
  formatTraceparent,
  generateTraceId,
  generateSpanId,
  createTraceContext,
} from '../../src/core/infra/trace-context.js';

describe('TraceContext', () => {
  describe('parseTraceparent', () => {
    it('parses a valid traceparent header', () => {
      const result = parseTraceparent('00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-01');
      assert.deepEqual(result, {
        version: '00',
        traceId: '4bf92f3577b16e8d0e8340c6df70d19a',
        parentId: '00f067aa0ba902b7',
        traceFlags: '01',
      });
    });

    it('returns null for null/undefined/empty', () => {
      assert.equal(parseTraceparent(null), null);
      assert.equal(parseTraceparent(undefined), null);
      assert.equal(parseTraceparent(''), null);
    });

    it('returns null for non-string input', () => {
      assert.equal(parseTraceparent(42), null);
      assert.equal(parseTraceparent({}), null);
    });

    it('rejects version ff (reserved)', () => {
      assert.equal(
        parseTraceparent('ff-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-01'),
        null
      );
    });

    it('rejects all-zeros trace-id', () => {
      assert.equal(
        parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'),
        null
      );
    });

    it('rejects all-zeros parent-id', () => {
      assert.equal(
        parseTraceparent('00-4bf92f3577b16e8d0e8340c6df70d19a-0000000000000000-01'),
        null
      );
    });

    it('rejects malformed headers', () => {
      assert.equal(parseTraceparent('not-a-valid-header'), null);
      assert.equal(parseTraceparent('00-short-short-01'), null);
      assert.equal(parseTraceparent('00-GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG-00f067aa0ba902b7-01'), null);
    });

    it('handles leading/trailing whitespace', () => {
      const result = parseTraceparent('  00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-01  ');
      assert.ok(result);
      assert.equal(result.traceId, '4bf92f3577b16e8d0e8340c6df70d19a');
    });

    it('normalizes uppercase to lowercase', () => {
      const result = parseTraceparent('00-4BF92F3577B16E8D0E8340C6DF70D19A-00F067AA0BA902B7-01');
      assert.ok(result);
      assert.equal(result.traceId, '4bf92f3577b16e8d0e8340c6df70d19a');
      assert.equal(result.parentId, '00f067aa0ba902b7');
    });

    it('parses unsampled trace (flags 00)', () => {
      const result = parseTraceparent('00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-00');
      assert.ok(result);
      assert.equal(result.traceFlags, '00');
    });
  });

  describe('formatTraceparent', () => {
    it('formats a TraceContext into a header value', () => {
      const result = formatTraceparent({
        version: '00',
        traceId: '4bf92f3577b16e8d0e8340c6df70d19a',
        parentId: '00f067aa0ba902b7',
        traceFlags: '01',
      });
      assert.equal(result, '00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-01');
    });

    it('roundtrips with parseTraceparent', () => {
      const original = '00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-01';
      const parsed = parseTraceparent(original);
      const formatted = formatTraceparent(parsed);
      assert.equal(formatted, original);
    });
  });

  describe('generateTraceId', () => {
    it('produces a 32-character hex string', () => {
      const id = generateTraceId();
      assert.equal(id.length, 32);
      assert.match(id, /^[0-9a-f]{32}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
      assert.equal(ids.size, 100);
    });
  });

  describe('generateSpanId', () => {
    it('produces a 16-character hex string', () => {
      const id = generateSpanId();
      assert.equal(id.length, 16);
      assert.match(id, /^[0-9a-f]{16}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateSpanId()));
      assert.equal(ids.size, 100);
    });
  });

  describe('createTraceContext', () => {
    it('continues an existing trace when valid traceparent is provided', () => {
      const ctx = createTraceContext('00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-01');
      assert.equal(ctx.version, '00');
      assert.equal(ctx.traceId, '4bf92f3577b16e8d0e8340c6df70d19a'); // preserved
      assert.notEqual(ctx.parentId, '00f067aa0ba902b7'); // new span
      assert.equal(ctx.parentId.length, 16);
      assert.equal(ctx.traceFlags, '01'); // preserved
    });

    it('starts a new trace when no traceparent is provided', () => {
      const ctx = createTraceContext(null);
      assert.equal(ctx.version, '00');
      assert.equal(ctx.traceId.length, 32);
      assert.equal(ctx.parentId.length, 16);
      assert.equal(ctx.traceFlags, '01');
    });

    it('starts a new trace when traceparent is invalid', () => {
      const ctx = createTraceContext('invalid-header');
      assert.equal(ctx.version, '00');
      assert.equal(ctx.traceId.length, 32);
      assert.equal(ctx.parentId.length, 16);
    });

    it('preserves trace flags from incoming trace', () => {
      const ctx = createTraceContext('00-4bf92f3577b16e8d0e8340c6df70d19a-00f067aa0ba902b7-00');
      assert.equal(ctx.traceFlags, '00');
    });
  });
});
