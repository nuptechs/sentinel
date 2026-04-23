// ─────────────────────────────────────────────
// Tests — Domain: Finding
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Finding } from '../../src/core/domain/finding.js';

const VALID_PROPS = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  source: 'manual',
  type: 'bug',
  title: 'Button broken',
};

describe('Finding', () => {
  let finding;

  beforeEach(() => {
    finding = new Finding(VALID_PROPS);
  });

  it('creates with default values', () => {
    assert.ok(finding.id);
    assert.equal(finding.sessionId, 'sess-1');
    assert.equal(finding.projectId, 'proj-1');
    assert.equal(finding.source, 'manual');
    assert.equal(finding.type, 'bug');
    assert.equal(finding.severity, 'medium');
    assert.equal(finding.status, 'open');
    assert.equal(finding.title, 'Button broken');
    assert.equal(finding.diagnosis, null);
    assert.equal(finding.correction, null);
  });

  it('attachBrowserContext sets context and updates timestamp', () => {
    const ctx = { errors: [{ message: 'TypeError' }] };
    finding.attachBrowserContext(ctx);
    assert.deepEqual(finding.browserContext, ctx);
  });

  it('attachBackendContext sets context', () => {
    const ctx = { traces: [{ type: 'http_request' }] };
    finding.attachBackendContext(ctx);
    assert.deepEqual(finding.backendContext, ctx);
  });

  it('attachCodeContext sets context', () => {
    const ctx = { endpoint: '/api/users', controller: 'UserController' };
    finding.attachCodeContext(ctx);
    assert.deepEqual(finding.codeContext, ctx);
  });

  describe('status machine', () => {
    it('open → diagnosed', () => {
      finding.diagnose({ rootCause: 'null pointer' });
      assert.equal(finding.status, 'diagnosed');
      assert.deepEqual(finding.diagnosis, { rootCause: 'null pointer' });
    });

    it('diagnosed → fix_proposed', () => {
      finding.diagnose({ rootCause: 'x' });
      finding.proposeFix({ files: [] });
      assert.equal(finding.status, 'fix_proposed');
      assert.deepEqual(finding.correction, { files: [] });
    });

    it('fix_proposed → fix_applied', () => {
      finding.diagnose({ rootCause: 'x' });
      finding.proposeFix({ files: [] });
      finding.applyFix();
      assert.equal(finding.status, 'fix_applied');
    });

    it('fix_applied → verified', () => {
      finding.diagnose({ rootCause: 'x' });
      finding.proposeFix({ files: [] });
      finding.applyFix();
      finding.verify();
      assert.equal(finding.status, 'verified');
    });

    it('open → dismissed', () => {
      finding.dismiss();
      assert.equal(finding.status, 'dismissed');
    });
  });

  it('isEnriched returns false when no context', () => {
    assert.equal(finding.isEnriched(), false);
  });

  it('isEnriched returns true with browser context', () => {
    finding.attachBrowserContext({ errors: [] });
    assert.equal(finding.isEnriched(), true);
  });

  it('toJSON serializes all fields', () => {
    const json = finding.toJSON();
    assert.equal(json.id, finding.id);
    assert.equal(json.sessionId, 'sess-1');
    assert.equal(json.status, 'open');
    assert.equal(typeof json.createdAt, 'string');
    assert.equal(json.diagnosis, null);
    assert.equal(json.correction, null);
  });

  // Gap 11 — external system identifiers
  describe('external system ids', () => {
    it('defaults to null when not provided', () => {
      assert.equal(finding.correlationId, null);
      assert.equal(finding.debugProbeSessionId, null);
      assert.equal(finding.manifestProjectId, null);
      assert.equal(finding.manifestRunId, null);
    });

    it('accepts all four ids in the constructor', () => {
      const f = new Finding({
        ...VALID_PROPS,
        correlationId: 'corr-abc',
        debugProbeSessionId: 'dp-123',
        manifestProjectId: 'mp-9',
        manifestRunId: 'run-42',
      });
      assert.equal(f.correlationId, 'corr-abc');
      assert.equal(f.debugProbeSessionId, 'dp-123');
      assert.equal(f.manifestProjectId, 'mp-9');
      assert.equal(f.manifestRunId, 'run-42');
    });

    it('toJSON includes the four ids', () => {
      const f = new Finding({
        ...VALID_PROPS,
        correlationId: 'corr-abc',
        debugProbeSessionId: 'dp-123',
        manifestProjectId: 'mp-9',
        manifestRunId: 'run-42',
      });
      const json = f.toJSON();
      assert.equal(json.correlationId, 'corr-abc');
      assert.equal(json.debugProbeSessionId, 'dp-123');
      assert.equal(json.manifestProjectId, 'mp-9');
      assert.equal(json.manifestRunId, 'run-42');
    });
  });
});
