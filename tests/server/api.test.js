// ─────────────────────────────────────────────
// Tests — HTTP API Integration
// Spins up Express app with memory storage and
// tests the full HTTP contract end-to-end.
// ─────────────────────────────────────────────

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createApp } from '../../src/server/app.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { SessionService } from '../../src/core/services/session.service.js';
import { FindingService } from '../../src/core/services/finding.service.js';
import { DiagnosisService } from '../../src/core/services/diagnosis.service.js';
import { CorrectionService } from '../../src/core/services/correction.service.js';

// ── Helpers ─────────────────────────────────

function makeRequest(server, method, path, body = null) {
  const addr = server.address();
  const url = `http://127.0.0.1:${addr.port}${path}`;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Mocks for AI/Trace/Analyzer ─────────────

const noopAI = {
  isConfigured: () => true,
  diagnose: async () => ({ rootCause: 'test root cause', confidence: 0.85 }),
  generateCorrection: async () => ({ files: [{ path: 'app.js', diff: '+fix' }], summary: 'Applied fix' }),
  clarify: async () => 'The issue is related to X.',
};

const noopTrace = {
  isConfigured: () => false,
  getTraces: async () => [],
};

const noopAnalyzer = {
  isConfigured: () => false,
  resolveEndpoint: async () => null,
  getSourceFile: async () => null,
};

const noopNotification = {
  isConfigured: () => false,
  onDiagnosisReady: async () => {},
  onCorrectionReady: async () => {},
};

// ── Test Suite ──────────────────────────────

describe('HTTP API', () => {
  let server;
  let storage;

  before(async () => {
    storage = new MemoryStorageAdapter();
    await storage.initialize();

    const services = {
      sessions: new SessionService({ storage }),
      findings: new FindingService({ storage }),
      diagnosis: new DiagnosisService({
        storage,
        ai: noopAI,
        trace: noopTrace,
        analyzer: noopAnalyzer,
        notification: noopNotification,
      }),
      correction: new CorrectionService({
        storage,
        ai: noopAI,
        analyzer: noopAnalyzer,
      }),
    };

    const app = createApp(services);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise(resolve => server.close(resolve));
    await storage.close();
  });

  beforeEach(async () => {
    // Reset storage between tests
    storage.sessions.clear();
    storage.events = [];
    storage.findings.clear();
  });

  // ── Health ──────────────────────────────

  describe('GET /health', () => {
    it('returns ok', async () => {
      const res = await makeRequest(server, 'GET', '/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.ok(res.body.timestamp);
    });
  });

  // ── Sessions ────────────────────────────

  describe('POST /api/sessions', () => {
    it('creates a session', async () => {
      const res = await makeRequest(server, 'POST', '/api/sessions', {
        projectId: 'proj-1', userId: 'user-1',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.projectId, 'proj-1');
      assert.equal(res.body.data.status, 'active');
    });

    it('returns 400 without projectId', async () => {
      const res = await makeRequest(server, 'POST', '/api/sessions', {});
      assert.equal(res.status, 400);
      assert.equal(res.body.success, false);
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns existing session', async () => {
      const created = await makeRequest(server, 'POST', '/api/sessions', { projectId: 'p' });
      const id = created.body.data.id;

      const res = await makeRequest(server, 'GET', `/api/sessions/${id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, id);
    });

    it('returns 404 for missing session', async () => {
      const res = await makeRequest(server, 'GET', '/api/sessions/nonexistent');
      assert.equal(res.status, 404);
    });
  });

  describe('GET /api/sessions', () => {
    it('returns 400 without projectId', async () => {
      const res = await makeRequest(server, 'GET', '/api/sessions');
      assert.equal(res.status, 400);
    });

    it('lists sessions by project', async () => {
      await makeRequest(server, 'POST', '/api/sessions', { projectId: 'px' });
      await makeRequest(server, 'POST', '/api/sessions', { projectId: 'px' });

      const res = await makeRequest(server, 'GET', '/api/sessions?projectId=px');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
    });
  });

  // ── Events ──────────────────────────────

  describe('POST /api/sessions/:id/events', () => {
    it('ingests events', async () => {
      const session = await makeRequest(server, 'POST', '/api/sessions', { projectId: 'p' });
      const sid = session.body.data.id;

      const res = await makeRequest(server, 'POST', `/api/sessions/${sid}/events`, {
        events: [
          { type: 'error', source: 'window', timestamp: 1000, payload: { msg: 'boom' } },
          { type: 'network', source: 'fetch', timestamp: 1001, payload: { url: '/api' } },
        ],
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.count, 2);
    });

    it('returns 400 for missing events', async () => {
      const session = await makeRequest(server, 'POST', '/api/sessions', { projectId: 'p' });
      const sid = session.body.data.id;

      const res = await makeRequest(server, 'POST', `/api/sessions/${sid}/events`, {});
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/sessions/:id/events', () => {
    it('returns session events', async () => {
      const session = await makeRequest(server, 'POST', '/api/sessions', { projectId: 'p' });
      const sid = session.body.data.id;

      await makeRequest(server, 'POST', `/api/sessions/${sid}/events`, {
        events: [{ type: 'error', payload: { msg: 'e' } }],
      });

      const res = await makeRequest(server, 'GET', `/api/sessions/${sid}/events`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 1);
    });
  });

  // ── Session Complete ────────────────────

  describe('POST /api/sessions/:id/complete', () => {
    it('completes a session', async () => {
      const session = await makeRequest(server, 'POST', '/api/sessions', { projectId: 'p' });
      const sid = session.body.data.id;

      const res = await makeRequest(server, 'POST', `/api/sessions/${sid}/complete`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'completed');
    });
  });

  // ── Findings ────────────────────────────

  describe('POST /api/findings', () => {
    it('creates a finding', async () => {
      const res = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 'sess-1', projectId: 'proj-1',
        title: 'Button broken', type: 'bug', source: 'manual',
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.title, 'Button broken');
      assert.equal(res.body.data.status, 'open');
    });

    it('derives title from annotation', async () => {
      const res = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p',
        annotation: { description: 'The save button does nothing', url: '/page' },
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.title, 'The save button does nothing');
    });

    it('auto-diagnoses and auto-generates a correction when enabled', async () => {
      process.env.SENTINEL_AUTO_DIAGNOSE = 'true';
      process.env.SENTINEL_AUTO_CORRECT = 'true';

      try {
        const created = await makeRequest(server, 'POST', '/api/findings', {
          sessionId: 'sess-auto',
          projectId: 'proj-auto',
          title: 'Auto process me',
          type: 'bug',
          source: 'manual',
        });

        assert.equal(created.status, 201);

        await new Promise(resolve => setTimeout(resolve, 25));

        const found = await makeRequest(server, 'GET', `/api/findings/${created.body.data.id}`);
        assert.equal(found.status, 200);
        assert.equal(found.body.data.status, 'fix_proposed');
        assert.ok(found.body.data.diagnosis);
        assert.ok(found.body.data.correction);
      } finally {
        delete process.env.SENTINEL_AUTO_DIAGNOSE;
        delete process.env.SENTINEL_AUTO_CORRECT;
      }
    });

    it('returns 400 without sessionId', async () => {
      const res = await makeRequest(server, 'POST', '/api/findings', { projectId: 'p' });
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/findings/:id', () => {
    it('returns existing finding', async () => {
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'Test', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      const res = await makeRequest(server, 'GET', `/api/findings/${id}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, id);
    });

    it('returns 404 for missing finding', async () => {
      const res = await makeRequest(server, 'GET', '/api/findings/nonexistent');
      assert.equal(res.status, 404);
    });
  });

  describe('GET /api/findings', () => {
    it('returns 400 without sessionId or projectId', async () => {
      const res = await makeRequest(server, 'GET', '/api/findings');
      assert.equal(res.status, 400);
    });

    it('lists by project', async () => {
      await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'px', title: 'A', source: 'manual', type: 'bug',
      });
      await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'px', title: 'B', source: 'manual', type: 'bug',
      });

      const res = await makeRequest(server, 'GET', '/api/findings?projectId=px');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.length, 2);
    });
  });

  // ── Finding Actions ─────────────────────

  describe('POST /api/findings/:id/dismiss', () => {
    it('dismisses a finding', async () => {
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'Dismiss me', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      const res = await makeRequest(server, 'POST', `/api/findings/${id}/dismiss`, {
        reason: 'Not a real bug',
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'dismissed');
    });
  });

  describe('POST /api/findings/:id/diagnose', () => {
    it('diagnoses a finding', async () => {
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'Diagnose me', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      const res = await makeRequest(server, 'POST', `/api/findings/${id}/diagnose`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'diagnosed');
      assert.ok(res.body.data.diagnosis);
    });
  });

  describe('POST /api/findings/:id/correct', () => {
    it('generates a correction', async () => {
      // Create → diagnose → correct
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'Fix me', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      await makeRequest(server, 'POST', `/api/findings/${id}/diagnose`);
      const res = await makeRequest(server, 'POST', `/api/findings/${id}/correct`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'fix_proposed');
      assert.ok(res.body.data.correction);
    });
  });

  describe('POST /api/findings/:id/clarify', () => {
    it('answers a question about a finding', async () => {
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'Clarify me', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      const res = await makeRequest(server, 'POST', `/api/findings/${id}/clarify`, {
        question: 'Why does this happen?',
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.data.answer);
    });

    it('returns 400 without question', async () => {
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'No Q', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      const res = await makeRequest(server, 'POST', `/api/findings/${id}/clarify`, {});
      assert.equal(res.status, 400);
    });
  });

  describe('POST /api/findings/:id/apply', () => {
    it('marks correction as applied', async () => {
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'Apply fix', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      await makeRequest(server, 'POST', `/api/findings/${id}/diagnose`);
      await makeRequest(server, 'POST', `/api/findings/${id}/correct`);
      const res = await makeRequest(server, 'POST', `/api/findings/${id}/apply`);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'fix_applied');
    });
  });

  describe('POST /api/findings/:id/verify', () => {
    it('verifies a finding', async () => {
      const created = await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's', projectId: 'p', title: 'Verify me', source: 'manual', type: 'bug',
      });
      const id = created.body.data.id;

      await makeRequest(server, 'POST', `/api/findings/${id}/diagnose`);
      await makeRequest(server, 'POST', `/api/findings/${id}/correct`);
      await makeRequest(server, 'POST', `/api/findings/${id}/apply`);
      const res = await makeRequest(server, 'POST', `/api/findings/${id}/verify`, { verified: true });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, 'verified');
    });
  });

  // ── Projects ────────────────────────────

  describe('GET /api/projects/:id/stats', () => {
    it('returns project stats', async () => {
      // Create sessions + findings
      await makeRequest(server, 'POST', '/api/sessions', { projectId: 'stats-proj' });
      await makeRequest(server, 'POST', '/api/sessions', { projectId: 'stats-proj' });
      await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's1', projectId: 'stats-proj', title: 'A', type: 'bug', source: 'manual',
      });
      await makeRequest(server, 'POST', '/api/findings', {
        sessionId: 's2', projectId: 'stats-proj', title: 'B', type: 'ux', source: 'auto', severity: 'high',
      });

      const res = await makeRequest(server, 'GET', '/api/projects/stats-proj/stats');
      assert.equal(res.status, 200);
      assert.equal(res.body.data.totalSessions, 2);
      assert.equal(res.body.data.totalFindings, 2);
      assert.ok(res.body.data.byStatus);
      assert.ok(res.body.data.byType);
    });
  });

  // ── 404 handler ─────────────────────────

  describe('Unknown routes', () => {
    it('returns 404 JSON', async () => {
      const res = await makeRequest(server, 'GET', '/nonexistent/path');
      assert.equal(res.status, 404);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, 'NOT_FOUND');
    });
  });
});
