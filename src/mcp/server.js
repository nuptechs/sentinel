// ─────────────────────────────────────────────
// Sentinel — MCP Server (Official SDK)
// Model Context Protocol server that exposes
// findings, diagnoses, and corrections to
// coding agents (Cursor, Claude Code, Copilot)
//
// Uses @modelcontextprotocol/sdk v1.x
// Transport: stdio or Streamable HTTP (spec 2025-11-25)
// ─────────────────────────────────────────────

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { registry as metricsRegistry } from '../observability/metrics.js';

const SERVER_NAME = 'sentinel-mcp';
const SERVER_VERSION = '0.2.0';
const FINDING_STATUSES = ['open', 'diagnosed', 'fix_proposed', 'fix_applied', 'verified', 'dismissed'];

function toTextResult(payload, { isError = false } = {}) {
  return {
    content: [{
      type: 'text',
      text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2),
    }],
    ...(isError ? { isError: true } : {}),
  };
}

function buildToolRegistry(services) {
  return [
    {
      name: 'list_findings',
      title: 'List Findings',
      description: 'List QA findings for a project, optionally filtered by status and severity. Returns finding IDs, titles, status, severity, and page URLs.',
      inputSchema: {
        projectId: z.string().min(1).describe('The project ID to list findings for'),
        status: z.enum(FINDING_STATUSES).optional().describe('Filter by status'),
        limit: z.number().int().positive().max(100).default(20).describe('Max results (default 20)'),
      },
      execute: async ({ projectId, status, limit = 20 }) => {
        const findings = await services.findings.listByProject(projectId, {
          status,
          limit: Math.min(limit, 100),
        });
        const summary = findings.map((finding) => ({
          id: finding.id,
          title: finding.title,
          status: finding.status,
          severity: finding.severity,
          type: finding.type,
          pageUrl: finding.pageUrl,
          createdAt: finding.createdAt,
          hasDiagnosis: !!finding.diagnosis,
          hasCorrection: !!finding.correction,
        }));
        return { count: summary.length, findings: summary };
      },
    },
    {
      name: 'get_finding_details',
      title: 'Get Finding Details',
      description: 'Get full details of a finding including browser context, backend traces, annotation, and any existing diagnosis or correction.',
      inputSchema: {
        findingId: z.string().min(1).describe('The finding UUID'),
      },
      execute: async ({ findingId }) => {
        const finding = await services.findings.get(findingId);
        return finding.toJSON();
      },
    },
    {
      name: 'diagnose_finding',
      title: 'Diagnose Finding',
      description: 'Trigger AI diagnosis for a finding. Enriches with backend traces and code context, then uses Claude to identify root cause. Returns the diagnosis with affected files and suggested fix.',
      inputSchema: {
        findingId: z.string().min(1).describe('The finding UUID to diagnose'),
      },
      execute: async ({ findingId }) => {
        const finding = await services.diagnosis.diagnose(findingId);
        return {
          findingId: finding.id,
          status: finding.status,
          diagnosis: finding.diagnosis,
          codeContext: finding.codeContext,
        };
      },
    },
    {
      name: 'get_correction',
      title: 'Get Correction',
      description: 'Generate AI code correction for a diagnosed finding. Returns file-level diffs with original and modified code, explanations, and test suggestions.',
      inputSchema: {
        findingId: z.string().min(1).describe('The finding UUID (must be diagnosed first)'),
      },
      execute: async ({ findingId }) => {
        const finding = await services.correction.generateCorrection(findingId);
        return {
          findingId: finding.id,
          status: finding.status,
          correction: finding.correction,
        };
      },
    },
    {
      name: 'push_to_tracker',
      title: 'Push to Tracker',
      description: 'Push a finding to the configured issue tracker (GitHub Issues, Linear, or Jira). Creates an issue with the finding details, diagnosis, and suggested fix.',
      inputSchema: {
        findingId: z.string().min(1).describe('The finding UUID to push'),
      },
      execute: async ({ findingId }) => {
        if (!services.integration) {
          return {
            payload: { error: 'No issue tracker configured' },
            isError: true,
          };
        }

        const result = await services.integration.pushToTracker(findingId);
        return { payload: result };
      },
    },
    {
      name: 'mark_fix_applied',
      title: 'Mark Fix Applied',
      description: 'Mark a finding as having its fix applied in code.',
      inputSchema: {
        findingId: z.string().min(1).describe('The finding UUID'),
      },
      execute: async ({ findingId }) => {
        const finding = await services.findings.markApplied(findingId);
        return { findingId: finding.id, status: finding.status };
      },
    },
    {
      name: 'get_project_stats',
      title: 'Project Stats',
      description: 'Get aggregated statistics for a project: total findings, by status, by severity, by type.',
      inputSchema: {
        projectId: z.string().min(1).describe('The project ID'),
      },
      execute: async ({ projectId }) => {
        const [sessions, findings] = await Promise.all([
          services.sessions.list(projectId, { limit: 1000 }),
          services.findings.listByProject(projectId, { limit: 1000 }),
        ]);

        const stats = {
          projectId,
          totalSessions: sessions.length,
          activeSessions: sessions.filter((session) => session.status === 'active').length,
          totalFindings: findings.length,
          byStatus: {},
          bySeverity: {},
          byType: {},
        };

        for (const finding of findings) {
          stats.byStatus[finding.status] = (stats.byStatus[finding.status] || 0) + 1;
          if (finding.severity) stats.bySeverity[finding.severity] = (stats.bySeverity[finding.severity] || 0) + 1;
          if (finding.type) stats.byType[finding.type] = (stats.byType[finding.type] || 0) + 1;
        }

        return stats;
      },
    },
    {
      name: 'get_traces',
      title: 'Get Backend Traces',
      description: 'Retrieve backend HTTP + SQL traces for a QA session. Returns an array of correlated request/response/queries entries from Debug Probe (or the configured trace adapter). Use this to inspect what the backend did while the user reproduced the bug.',
      inputSchema: {
        sessionId: z.string().min(1).describe('The Sentinel session ID'),
        since: z.number().int().optional().describe('Unix ms — only traces at/after this timestamp'),
        until: z.number().int().optional().describe('Unix ms — only traces at/before this timestamp'),
        limit: z.number().int().positive().max(500).default(100).describe('Max traces (default 100)'),
      },
      execute: async ({ sessionId, since, until, limit = 100 }) => {
        const trace = services.trace;
        if (!trace || typeof trace.getTraces !== 'function' || !trace.isConfigured?.()) {
          return {
            payload: { error: 'No trace adapter configured', traces: [] },
            isError: true,
          };
        }
        const traces = await trace.getTraces(sessionId, { since, until, limit });
        return { sessionId, count: traces.length, traces };
      },
    },
    {
      name: 'get_code_chain',
      title: 'Get Code Chain',
      description: 'Resolve the full backend call chain (controller → service → repository) for a finding. Uses the finding\'s existing codeContext when available, otherwise falls back to the analyzer for the page URL.',
      inputSchema: {
        findingId: z.string().min(1).describe('The finding UUID'),
      },
      execute: async ({ findingId }) => {
        const finding = await services.findings.get(findingId);
        if (finding.codeContext) {
          return {
            findingId: finding.id,
            source: 'cached',
            codeContext: finding.codeContext,
          };
        }

        const analyzer = services.analyzer;
        if (!analyzer || typeof analyzer.resolveEndpoint !== 'function' || !analyzer.isConfigured?.()) {
          return {
            payload: { error: 'No analyzer configured and no cached codeContext', findingId },
            isError: true,
          };
        }

        const projectId = finding.manifestProjectId || finding.projectId;
        // Best-effort endpoint derivation from the first backend trace on the finding
        const endpoint = finding.backendContext?.traces?.[0]?.request?.path
          || finding.backendContext?.traces?.[0]?.path
          || null;
        const method = finding.backendContext?.traces?.[0]?.request?.method
          || finding.backendContext?.traces?.[0]?.method
          || 'GET';

        if (!endpoint) {
          return {
            payload: { error: 'Cannot infer endpoint for finding (no backendContext.traces)', findingId },
            isError: true,
          };
        }

        const chain = await analyzer.resolveEndpoint(projectId, endpoint, method);
        return { findingId, source: 'analyzer', projectId, endpoint, method, codeContext: chain };
      },
    },
    {
      name: 'get_source_file',
      title: 'Get Source File',
      description: 'Fetch the contents of a project source file via the analyzer (Manifest). Used to inspect code implicated in a diagnosis or correction.',
      inputSchema: {
        projectId: z.string().min(1).describe('The analyzer project ID (typically finding.manifestProjectId)'),
        path: z.string().min(1).describe('Project-relative file path'),
      },
      execute: async ({ projectId, path }) => {
        const analyzer = services.analyzer;
        if (!analyzer || typeof analyzer.getSourceFile !== 'function' || !analyzer.isConfigured?.()) {
          return {
            payload: { error: 'No analyzer configured' },
            isError: true,
          };
        }
        const source = await analyzer.getSourceFile(projectId, path);
        if (source == null) {
          return {
            payload: { error: `Source file not found: ${path}`, projectId, path },
            isError: true,
          };
        }
        return { projectId, path, source };
      },
    },
    {
      name: 'collect_live_traces',
      title: 'Collect Live Traces (WebSocket)',
      description: 'Subscribe to the trace adapter\'s realtime WebSocket bridge for a fixed window and return the collected events. Useful when the agent needs to observe what the backend does as the user reproduces an issue in real time. Falls back gracefully when the adapter lacks a live channel.',
      inputSchema: {
        sessionId: z.string().min(1).describe('The Sentinel session ID'),
        durationMs: z.number().int().min(100).max(60_000).default(5000)
          .describe('Collection window in ms (100–60000, default 5000)'),
        limit: z.number().int().positive().max(1000).default(100)
          .describe('Max events collected (default 100)'),
      },
      execute: async ({ sessionId, durationMs = 5000, limit = 100 }) => {
        const trace = services.trace;
        if (!trace || typeof trace.collectLive !== 'function' || !trace.isConfigured?.()) {
          return {
            payload: { error: 'No trace adapter configured', events: [] },
            isError: true,
          };
        }
        const events = await trace.collectLive(sessionId, { durationMs, limit });
        return { sessionId, durationMs, count: events.length, events };
      },
    },
    {
      name: 'get_metrics_snapshot',
      title: 'Get Metrics Snapshot',
      description: 'Return a snapshot of Sentinel\'s Prometheus metrics (counters, histograms, and default Node.js runtime gauges) from the in-process registry. Lets coding agents inspect live system health (request rate, diagnosis outcomes, auto-enrich health, etc.) without hitting the HTTP /metrics endpoint.',
      inputSchema: {
        format: z.enum(['json', 'text']).default('json').optional()
          .describe('Output format: "json" (structured metrics) or "text" (raw Prometheus exposition). Default: json.'),
        prefix: z.string().optional()
          .describe('Optional metric-name prefix filter (e.g. "sentinel_http" to only include HTTP metrics).'),
      },
      execute: async ({ format = 'json', prefix } = {}) => {
        if (format === 'text') {
          const text = await metricsRegistry.metrics();
          const filtered = prefix
            ? text.split('\n').filter((line) =>
              line.startsWith('#') ? line.includes(prefix) : line.startsWith(prefix),
            ).join('\n')
            : text;
          return { payload: filtered };
        }
        const all = await metricsRegistry.getMetricsAsJSON();
        const metrics = prefix ? all.filter((m) => m.name.startsWith(prefix)) : all;
        return {
          contentType: metricsRegistry.contentType,
          count: metrics.length,
          metrics,
        };
      },
    },
  ];
}

/**
 * Create and configure an MCP server with all Sentinel tools registered.
 * Returns the McpServer instance — caller connects a transport (stdio or HTTP/SSE).
 */
export function createSentinelMCP(services) {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { logging: {} } },
  );

  for (const tool of buildToolRegistry(services)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args = {}) => {
        const result = await tool.execute(args);
        return toTextResult(result?.payload ?? result, { isError: !!result?.isError });
      },
    );
  }

  return server;
}

/**
 * Thin compatibility facade for older in-repo callers/tests that still exercise
 * the pre-SDK JSON-RPC handler directly.
 */
export class MCPServer {
  constructor({ services }) {
    this.tools = buildToolRegistry(services);
  }

  getToolDefinitions() {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(z.object(tool.inputSchema)),
    }));
  }

  async executeTool(name, args = {}) {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return toTextResult({ error: `Unknown tool: ${name}` }, { isError: true });
    }

    const result = await tool.execute(args);
    return toTextResult(result?.payload ?? result, { isError: !!result?.isError });
  }

  async handleMessage(message) {
    const { id = null, method, params } = message || {};

    switch (method) {
      case 'initialize': {
        const requestedVersion = params?.protocolVersion;
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : LATEST_PROTOCOL_VERSION;

        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
              logging: {},
            },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }

      case 'notifications/initialized':
        return null;

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: { tools: this.getToolDefinitions() },
        };

      case 'tools/call':
        return {
          jsonrpc: '2.0',
          id,
          result: await this.executeTool(params?.name, params?.arguments || {}),
        };

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }
}
