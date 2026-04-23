// ─────────────────────────────────────────────
// Tests — MCPServer legacy facade (server.js lines 204-276)
// Tests the pre-SDK JSON-RPC handler: handleMessage,
// executeTool, getToolDefinitions.
// ─────────────────────────────────────────────

import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { MCPServer } from '../../src/mcp/server.js';

// ── Mock services ───────────────────────────

function mockServices() {
  return {
    sessions: {
      list: mock.fn(async () => [
        { id: 's1', status: 'active' },
        { id: 's2', status: 'completed' },
      ]),
    },
    findings: {
      listByProject: mock.fn(async () => [
        { id: 'f1', title: 'Bug', severity: 'high', status: 'open', type: 'bug', pageUrl: '/p', createdAt: new Date(), diagnosis: null, correction: null },
      ]),
      get: mock.fn(async (id) => ({
        id, title: 'Bug', severity: 'high', status: 'open', type: 'bug',
        toJSON() { return this; },
      })),
      markApplied: mock.fn(async (id) => ({ id, status: 'fix_applied' })),
    },
    diagnosis: {
      diagnose: mock.fn(async () => ({
        id: 'f1', status: 'diagnosed',
        diagnosis: { rootCause: 'X', confidence: 0.9 },
        codeContext: null,
      })),
    },
    correction: {
      generateCorrection: mock.fn(async () => ({
        id: 'f1', status: 'fix_proposed',
        correction: { files: [], summary: 'Fixed' },
      })),
    },
    integration: {
      pushToTracker: mock.fn(async () => ({
        ref: { id: '1', url: 'https://github.com/x/1', tracker: 'github' },
      })),
    },
  };
}

// ── Tests ───────────────────────────────────

describe('MCPServer (legacy facade)', () => {
  let mcp;
  let services;

  beforeEach(() => {
    services = mockServices();
    mcp = new MCPServer({ services });
  });

  // ── getToolDefinitions ────────────────────

  describe('getToolDefinitions', () => {
    it('returns 10 tool definitions with JSON schema', () => {
      const defs = mcp.getToolDefinitions();
      assert.equal(defs.length, 10);
      for (const def of defs) {
        assert.ok(def.name);
        assert.ok(def.description);
        assert.ok(def.inputSchema);
      }
    });

    it('includes all expected tool names', () => {
      const names = mcp.getToolDefinitions().map(d => d.name);
      assert.ok(names.includes('list_findings'));
      assert.ok(names.includes('get_finding_details'));
      assert.ok(names.includes('diagnose_finding'));
      assert.ok(names.includes('get_correction'));
      assert.ok(names.includes('push_to_tracker'));
      assert.ok(names.includes('mark_fix_applied'));
      assert.ok(names.includes('get_project_stats'));
    });
  });

  // ── executeTool ───────────────────────────

  describe('executeTool', () => {
    it('executes list_findings', async () => {
      const result = await mcp.executeTool('list_findings', { projectId: 'test' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.count, 1);
      assert.ok(data.findings);
    });

    it('executes get_finding_details', async () => {
      const result = await mcp.executeTool('get_finding_details', { findingId: 'f1' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.id, 'f1');
      assert.equal(data.title, 'Bug');
    });

    it('executes diagnose_finding', async () => {
      const result = await mcp.executeTool('diagnose_finding', { findingId: 'f1' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.status, 'diagnosed');
      assert.ok(data.diagnosis);
    });

    it('executes get_correction', async () => {
      const result = await mcp.executeTool('get_correction', { findingId: 'f1' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.status, 'fix_proposed');
      assert.ok(data.correction);
    });

    it('executes push_to_tracker', async () => {
      const result = await mcp.executeTool('push_to_tracker', { findingId: 'f1' });
      assert.equal(result.isError, undefined);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.ref);
    });

    it('push_to_tracker returns error when no integration service', async () => {
      services.integration = null;
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('push_to_tracker', { findingId: 'f1' });
      assert.equal(result.isError, true);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error.includes('No issue tracker'));
    });

    it('executes mark_fix_applied', async () => {
      const result = await mcp.executeTool('mark_fix_applied', { findingId: 'f1' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.status, 'fix_applied');
    });

    it('executes get_project_stats', async () => {
      const result = await mcp.executeTool('get_project_stats', { projectId: 'test' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.totalSessions, 2);
      assert.equal(data.totalFindings, 1);
      assert.ok(data.byStatus);
      assert.ok(data.bySeverity);
      assert.ok(data.byType);
    });

    // Gap 9 — new cross-system MCP tools
    it('get_traces returns traces when trace adapter configured', async () => {
      services.trace = {
        isConfigured: () => true,
        getTraces: async () => [{ correlationId: 'c1', payload: {} }],
      };
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_traces', { sessionId: 's1' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.count, 1);
      assert.equal(data.sessionId, 's1');
    });

    it('get_traces returns isError when trace adapter unconfigured', async () => {
      services.trace = { isConfigured: () => false, getTraces: async () => [] };
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_traces', { sessionId: 's1' });
      assert.equal(result.isError, true);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error.includes('No trace adapter'));
    });

    it('get_code_chain returns cached codeContext when present', async () => {
      services.findings.get = mock.fn(async (id) => ({
        id, codeContext: { controller: 'FooCtl', service: 'FooSvc' },
      }));
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_code_chain', { findingId: 'f1' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.source, 'cached');
      assert.equal(data.codeContext.controller, 'FooCtl');
    });

    it('get_code_chain falls back to analyzer when no cached context', async () => {
      services.findings.get = mock.fn(async (id) => ({
        id,
        projectId: 'proj-1',
        manifestProjectId: 'mp-1',
        codeContext: null,
        backendContext: { traces: [{ request: { path: '/api/x', method: 'POST' } }] },
      }));
      services.analyzer = {
        isConfigured: () => true,
        resolveEndpoint: async (projectId, endpoint, method) => ({
          projectId, endpoint, method, chain: ['Ctl', 'Svc'],
        }),
      };
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_code_chain', { findingId: 'f1' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.source, 'analyzer');
      assert.equal(data.projectId, 'mp-1');
      assert.equal(data.endpoint, '/api/x');
      assert.equal(data.method, 'POST');
    });

    it('get_code_chain isError when analyzer unconfigured and no cache', async () => {
      services.findings.get = mock.fn(async (id) => ({ id, codeContext: null }));
      services.analyzer = null;
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_code_chain', { findingId: 'f1' });
      assert.equal(result.isError, true);
    });

    it('get_code_chain isError when endpoint cannot be derived', async () => {
      services.findings.get = mock.fn(async (id) => ({
        id, projectId: 'p', codeContext: null, backendContext: { traces: [] },
      }));
      services.analyzer = {
        isConfigured: () => true,
        resolveEndpoint: async () => ({}),
      };
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_code_chain', { findingId: 'f1' });
      assert.equal(result.isError, true);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error.includes('Cannot infer endpoint'));
    });

    it('get_source_file returns source when analyzer configured', async () => {
      services.analyzer = {
        isConfigured: () => true,
        getSourceFile: async () => 'class Foo {}',
      };
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_source_file', { projectId: 'p', path: 'Foo.java' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.source, 'class Foo {}');
    });

    it('get_source_file isError when analyzer unconfigured', async () => {
      services.analyzer = { isConfigured: () => false, getSourceFile: async () => null };
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_source_file', { projectId: 'p', path: 'x.java' });
      assert.equal(result.isError, true);
    });

    it('get_source_file isError when file not found', async () => {
      services.analyzer = { isConfigured: () => true, getSourceFile: async () => null };
      mcp = new MCPServer({ services });
      const result = await mcp.executeTool('get_source_file', { projectId: 'p', path: 'x.java' });
      assert.equal(result.isError, true);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error.includes('not found'));
    });

    it('returns error for unknown tool', async () => {
      const result = await mcp.executeTool('nonexistent', {});
      assert.equal(result.isError, true);
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.error.includes('Unknown tool'));
    });
  });

  // ── handleMessage ─────────────────────────

  describe('handleMessage', () => {
    it('handles initialize with supported protocol version', async () => {
      const result = await mcp.handleMessage({
        id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } },
      });
      assert.equal(result.jsonrpc, '2.0');
      assert.equal(result.id, 1);
      assert.equal(result.result.serverInfo.name, 'sentinel-mcp');
      assert.equal(result.result.protocolVersion, '2024-11-05');
    });

    it('handles initialize with unsupported version → falls back to LATEST', async () => {
      const result = await mcp.handleMessage({
        id: 2, method: 'initialize',
        params: { protocolVersion: '1999-01-01' },
      });
      assert.equal(result.result.serverInfo.name, 'sentinel-mcp');
      // Falls back to latest protocol version
      assert.ok(result.result.protocolVersion);
      assert.notEqual(result.result.protocolVersion, '1999-01-01');
    });

    it('handles notifications/initialized → returns null', async () => {
      const result = await mcp.handleMessage({ method: 'notifications/initialized' });
      assert.equal(result, null);
    });

    it('handles ping', async () => {
      const result = await mcp.handleMessage({ id: 3, method: 'ping' });
      assert.equal(result.jsonrpc, '2.0');
      assert.equal(result.id, 3);
      assert.deepEqual(result.result, {});
    });

    it('handles tools/list', async () => {
      const result = await mcp.handleMessage({ id: 4, method: 'tools/list' });
      assert.equal(result.result.tools.length, 10);
    });

    it('handles tools/call → delegates to executeTool', async () => {
      const result = await mcp.handleMessage({
        id: 5, method: 'tools/call',
        params: { name: 'get_finding_details', arguments: { findingId: 'f1' } },
      });
      assert.ok(result.result.content);
      const data = JSON.parse(result.result.content[0].text);
      assert.equal(data.id, 'f1');
    });

    it('handles tools/call with no arguments', async () => {
      const result = await mcp.handleMessage({
        id: 6, method: 'tools/call',
        params: { name: 'nonexistent' },
      });
      assert.ok(result.result.isError);
    });

    it('handles unknown method → -32601', async () => {
      const result = await mcp.handleMessage({ id: 7, method: 'unknown/method' });
      assert.equal(result.error.code, -32601);
      assert.ok(result.error.message.includes('unknown/method'));
    });

    it('handles null/undefined message', async () => {
      const result = await mcp.handleMessage(null);
      // method is undefined → falls through to default
      assert.equal(result.error.code, -32601);
    });

    it('defaults id to null when not provided', async () => {
      const result = await mcp.handleMessage({ method: 'ping' });
      assert.equal(result.id, null);
    });
  });
});
