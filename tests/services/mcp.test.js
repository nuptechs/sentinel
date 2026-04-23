// ─────────────────────────────────────────────
// Tests — MCP Server (official SDK)
// Exercises the real MCP request/response flow
// through a mock transport.
// ─────────────────────────────────────────────

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSentinelMCP } from '../../src/mcp/server.js';

// ── Mock factories ──────────────────────────

function createMockServices() {
  return {
    sessions: {
      list: mock.fn(async () => [
        { id: 's1', status: 'active' },
        { id: 's2', status: 'completed' },
      ]),
    },
    findings: {
      listByProject: mock.fn(async () => [
        { id: 'f1', title: 'Bug 1', severity: 'high', status: 'open', type: 'bug' },
        { id: 'f2', title: 'Bug 2', severity: 'low', status: 'diagnosed', type: 'ux' },
      ]),
      get: mock.fn(async (id) => ({
        id,
        title: 'Bug detail',
        severity: 'high',
        status: 'open',
        type: 'bug',
        description: 'Something broke',
        annotation: {},
        diagnosis: null,
        correction: null,
        toJSON() { return this; },
      })),
      markApplied: mock.fn(async (id) => ({ id, status: 'fix_applied' })),
    },
    diagnosis: {
      diagnose: mock.fn(async () => ({
        id: 'f1',
        status: 'diagnosed',
        diagnosis: { rootCause: 'Test root cause', confidence: 0.9, suggestedFix: 'Fix X' },
        codeContext: null,
      })),
    },
    correction: {
      generateCorrection: mock.fn(async () => ({
        id: 'f1',
        status: 'fix_proposed',
        correction: { files: [{ path: 'app.js', diff: '+fix' }], summary: 'Applied fix' },
      })),
    },
    integration: {
      pushToTracker: mock.fn(async () => ({
        alreadyPushed: false,
        ref: { id: '42', url: 'https://github.com/test/42', tracker: 'github' },
      })),
    },
  };
}

class MockTransport {
  constructor() {
    this.started = false;
    this.sent = [];
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
  }

  async start() {
    this.started = true;
  }

  async send(message) {
    this.sent.push(message);
  }

  async close() {
    this.onclose?.();
  }
}

async function sendMessage(transport, message) {
  assert.ok(transport.onmessage, 'Transport must be connected before sending requests');

  const previousCount = transport.sent.length;
  await transport.onmessage(message);
  await new Promise((resolve) => setImmediate(resolve));

  return transport.sent[previousCount] ?? null;
}

// ── Test Suite ──────────────────────────────

describe('createSentinelMCP', () => {
  let server;
  let services;
  let transport;
  let initializeResult;

  beforeEach(async () => {
    services = createMockServices();
    transport = new MockTransport();
    server = createSentinelMCP(services);

    await server.connect(transport);

    initializeResult = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'sentinel-test-client', version: '1.0.0' },
      },
    });

    await sendMessage(transport, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
  });

  afterEach(async () => {
    await server.close?.();
  });

  it('connects the mock transport and negotiates initialization', async () => {
    assert.equal(transport.started, true);
    assert.equal(initializeResult.jsonrpc, '2.0');
    assert.equal(initializeResult.id, 1);
    assert.equal(initializeResult.result.serverInfo.name, 'sentinel-mcp');
    assert.equal(initializeResult.result.protocolVersion, '2024-11-05');
  });

  it('lists all 10 tools via the SDK transport', async () => {
    const result = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    assert.ok(result.result.tools);
    assert.equal(result.result.tools.length, 10);

    const names = result.result.tools.map((tool) => tool.name);
    assert.ok(names.includes('list_findings'));
    assert.ok(names.includes('get_finding_details'));
    assert.ok(names.includes('diagnose_finding'));
    assert.ok(names.includes('get_correction'));
    assert.ok(names.includes('push_to_tracker'));
    assert.ok(names.includes('mark_fix_applied'));
    assert.ok(names.includes('get_project_stats'));
    assert.ok(names.includes('get_traces'));
    assert.ok(names.includes('get_code_chain'));
    assert.ok(names.includes('get_source_file'));
  });

  it('executes list_findings', async () => {
    const result = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'list_findings', arguments: { projectId: 'test' } },
    });

    assert.ok(result.result.content);
    const data = JSON.parse(result.result.content[0].text);
    assert.equal(data.count, 2);
    assert.ok(data.findings);
  });

  it('executes diagnose_finding and get_correction through the registered tools', async () => {
    const diagnosis = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'diagnose_finding', arguments: { findingId: 'f1' } },
    });
    const correction = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'get_correction', arguments: { findingId: 'f1' } },
    });

    assert.equal(services.diagnosis.diagnose.mock.calls.length, 1);
    assert.equal(services.correction.generateCorrection.mock.calls.length, 1);
    assert.ok(JSON.parse(diagnosis.result.content[0].text).diagnosis);
    assert.ok(JSON.parse(correction.result.content[0].text).correction);
  });

  it('pushes findings to the issue tracker and can mark fixes as applied', async () => {
    const pushed = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 13,
      method: 'tools/call',
      params: { name: 'push_to_tracker', arguments: { findingId: 'f1' } },
    });
    const applied = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 14,
      method: 'tools/call',
      params: { name: 'mark_fix_applied', arguments: { findingId: 'f1' } },
    });

    assert.equal(services.integration.pushToTracker.mock.calls.length, 1);
    assert.equal(services.findings.markApplied.mock.calls.length, 1);
    assert.ok(JSON.parse(pushed.result.content[0].text).ref);
    assert.equal(JSON.parse(applied.result.content[0].text).status, 'fix_applied');
  });

  it('returns project statistics and surfaces tool-level errors cleanly', async () => {
    services.integration = null;

    const stats = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 15,
      method: 'tools/call',
      params: { name: 'get_project_stats', arguments: { projectId: 'test' } },
    });
    const missingTracker = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 16,
      method: 'tools/call',
      params: { name: 'push_to_tracker', arguments: { findingId: 'f1' } },
    });

    const statsData = JSON.parse(stats.result.content[0].text);
    const errorData = JSON.parse(missingTracker.result.content[0].text);

    assert.equal(statsData.totalFindings, 2);
    assert.equal(statsData.totalSessions, 2);
    assert.equal(missingTracker.result.isError, true);
    assert.equal(errorData.error, 'No issue tracker configured');
  });

  it('returns an error for unsupported methods or unknown tools', async () => {
    const unknownMethod = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 17,
      method: 'unknown/method',
    });
    const unknownTool = await sendMessage(transport, {
      jsonrpc: '2.0',
      id: 18,
      method: 'tools/call',
      params: { name: 'nonexistent_tool', arguments: {} },
    });

    assert.equal(unknownMethod.error.code, -32601);
    assert.ok(unknownTool.error || unknownTool.result?.isError);
  });
});
