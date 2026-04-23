// ─────────────────────────────────────────────
// Tests — FindingService
// ─────────────────────────────────────────────

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FindingService } from '../../src/core/services/finding.service.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { ValidationError, NotFoundError } from '../../src/core/errors.js';

const VALID_FINDING = {
  sessionId: 'sess-1',
  projectId: 'proj-1',
  source: 'manual',
  type: 'bug',
  title: 'Button broken',
};

describe('FindingService', () => {
  let service;
  let storage;

  beforeEach(() => {
    storage = new MemoryStorageAdapter();
    service = new FindingService({ storage });
  });

  describe('create', () => {
    it('creates finding with valid data', async () => {
      const finding = await service.create(VALID_FINDING);
      assert.ok(finding.id);
      assert.equal(finding.title, 'Button broken');
      assert.equal(finding.status, 'open');
    });

    it('throws without sessionId', async () => {
      await assert.rejects(
        () => service.create({ ...VALID_FINDING, sessionId: null }),
        (err) => err instanceof ValidationError
      );
    });

    it('throws without projectId', async () => {
      await assert.rejects(
        () => service.create({ ...VALID_FINDING, projectId: null }),
        (err) => err instanceof ValidationError
      );
    });

    it('throws without title', async () => {
      await assert.rejects(
        () => service.create({ ...VALID_FINDING, title: '' }),
        (err) => err instanceof ValidationError
      );
    });

    it('throws without source', async () => {
      await assert.rejects(
        () => service.create({ ...VALID_FINDING, source: null }),
        (err) => err instanceof ValidationError
      );
    });

    it('throws without type', async () => {
      await assert.rejects(
        () => service.create({ ...VALID_FINDING, type: null }),
        (err) => err instanceof ValidationError
      );
    });

    // Gap 11 — external system ids
    it('persists explicit external ids when provided', async () => {
      await storage.createSession({
        id: 'sess-1',
        projectId: 'proj-1',
        status: 'active',
        metadata: {},
      });
      const f = await service.create({
        ...VALID_FINDING,
        correlationId: 'corr-xyz',
        debugProbeSessionId: 'dp-111',
        manifestProjectId: 'mp-1',
        manifestRunId: 'run-1',
      });
      assert.equal(f.correlationId, 'corr-xyz');
      assert.equal(f.debugProbeSessionId, 'dp-111');
      assert.equal(f.manifestProjectId, 'mp-1');
      assert.equal(f.manifestRunId, 'run-1');
    });

    it('backfills debugProbeSessionId from session.metadata when omitted', async () => {
      await storage.createSession({
        id: 'sess-1',
        projectId: 'proj-1',
        status: 'active',
        metadata: { debugProbeSessionId: 'dp-from-session' },
      });
      const f = await service.create(VALID_FINDING);
      assert.equal(f.debugProbeSessionId, 'dp-from-session');
    });

    it('does not fail when session lookup for backfill throws', async () => {
      const brokenStorage = new MemoryStorageAdapter();
      brokenStorage.getSession = async () => { throw new Error('db down'); };
      const svc = new FindingService({ storage: brokenStorage });
      const f = await svc.create(VALID_FINDING);
      assert.equal(f.debugProbeSessionId, null);
    });
  });

  describe('get', () => {
    it('returns existing finding', async () => {
      const created = await service.create(VALID_FINDING);
      const fetched = await service.get(created.id);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.title, 'Button broken');
    });

    it('throws NotFoundError for missing', async () => {
      await assert.rejects(
        () => service.get('nope'),
        (err) => err instanceof NotFoundError
      );
    });
  });

  describe('listBySession', () => {
    it('filters by sessionId', async () => {
      await service.create(VALID_FINDING);
      await service.create({ ...VALID_FINDING, sessionId: 'other' });

      const list = await service.listBySession('sess-1');
      assert.equal(list.length, 1);
      assert.equal(list[0].sessionId, 'sess-1');
    });
  });

  describe('listByProject', () => {
    it('filters by projectId', async () => {
      await service.create(VALID_FINDING);
      await service.create({ ...VALID_FINDING, projectId: 'other' });

      const list = await service.listByProject('proj-1');
      assert.equal(list.length, 1);
    });
  });

  describe('dismiss', () => {
    it('transitions to dismissed', async () => {
      const f = await service.create(VALID_FINDING);
      const dismissed = await service.dismiss(f.id);
      assert.equal(dismissed.status, 'dismissed');
    });

    it('throws for missing finding', async () => {
      await assert.rejects(
        () => service.dismiss('nope'),
        (err) => err instanceof NotFoundError
      );
    });
  });

  describe('markApplied', () => {
    it('transitions to fix_applied', async () => {
      const f = await service.create(VALID_FINDING);
      const applied = await service.markApplied(f.id);
      assert.equal(applied.status, 'fix_applied');
    });
  });

  describe('verify', () => {
    it('transitions to verified', async () => {
      const f = await service.create(VALID_FINDING);
      const verified = await service.verify(f.id);
      assert.equal(verified.status, 'verified');
    });
  });
});
