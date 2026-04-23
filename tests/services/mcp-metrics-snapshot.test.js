// ─────────────────────────────────────────────
// Tests — MCP tool: get_metrics_snapshot
// Verifies that the tool returns the Sentinel
// Prometheus registry contents through the MCP
// JSON-RPC facade.
// ─────────────────────────────────────────────

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { MCPServer } from '../../src/mcp/server.js';
import {
  registry,
  resetMetrics,
  httpRequestsTotal,
  findingsCreatedTotal,
  diagnosesTotal,
} from '../../src/observability/metrics.js';

describe('MCP tool: get_metrics_snapshot', () => {
  let mcp;

  before(() => {
    resetMetrics();
    httpRequestsTotal.inc({ method: 'GET', route: '/health', status_code: '200' }, 3);
    findingsCreatedTotal.inc({ source: 'manual', type: 'bug' }, 1);
    diagnosesTotal.inc({ outcome: 'success' }, 2);
    mcp = new MCPServer({ services: {} });
  });

  it('is listed in tool definitions', () => {
    const names = mcp.getToolDefinitions().map((d) => d.name);
    assert.ok(names.includes('get_metrics_snapshot'));
  });

  it('returns JSON snapshot with sentinel_* metrics by default', async () => {
    const result = await mcp.executeTool('get_metrics_snapshot', {});
    const data = JSON.parse(result.content[0].text);

    assert.ok(Array.isArray(data.metrics));
    assert.ok(data.count > 0);
    assert.equal(data.contentType, registry.contentType);

    const names = data.metrics.map((m) => m.name);
    assert.ok(names.includes('sentinel_http_requests_total'));
    assert.ok(names.includes('sentinel_findings_created_total'));
    assert.ok(names.includes('sentinel_diagnoses_total'));
  });

  it('filters metrics by prefix', async () => {
    const result = await mcp.executeTool('get_metrics_snapshot', {
      prefix: 'sentinel_http',
    });
    const data = JSON.parse(result.content[0].text);

    assert.ok(data.metrics.length > 0);
    for (const metric of data.metrics) {
      assert.ok(
        metric.name.startsWith('sentinel_http'),
        `expected prefix "sentinel_http" on ${metric.name}`,
      );
    }
  });

  it('returns raw Prometheus text when format=text', async () => {
    const result = await mcp.executeTool('get_metrics_snapshot', {
      format: 'text',
    });
    const text = result.content[0].text;

    assert.equal(typeof text, 'string');
    assert.ok(text.includes('sentinel_http_requests_total'));
    assert.ok(text.includes('# HELP'));
  });

  it('filters text output by prefix', async () => {
    const result = await mcp.executeTool('get_metrics_snapshot', {
      format: 'text',
      prefix: 'sentinel_diagnoses',
    });
    const text = result.content[0].text;

    assert.ok(text.includes('sentinel_diagnoses_total'));
    assert.ok(!text.includes('sentinel_http_requests_total'));
  });
});
