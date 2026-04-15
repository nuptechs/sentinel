// ─────────────────────────────────────────────
// Sentinel — Express Server
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { requestId } from './middleware/request-id.js';
import { apiKeyAuth } from './middleware/api-key.js';
import { rateLimiter } from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createFindingRoutes } from './routes/findings.js';
import { createProjectRoutes } from './routes/projects.js';
import { createSentinelMCP } from '../mcp/server.js';

function sendMcpError(res, status, message, code = -32000) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

function registerMcpRoutes(app, services) {
  const streamableTransports = new Map();
  const legacySseTransports = new Map();

  app.all('/mcp', apiKeyAuth, async (req, res) => {
    try {
      const sessionId = req.get('mcp-session-id');
      let transport = sessionId ? streamableTransports.get(sessionId) : null;

      if (sessionId && transport && !(transport instanceof StreamableHTTPServerTransport)) {
        sendMcpError(res, 400, 'Bad Request: Session exists but uses a different transport protocol');
        return;
      }

      if (!transport) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          sendMcpError(res, 400, 'Bad Request: No valid session ID provided');
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            streamableTransports.set(newSessionId, transport);
          },
        });

        transport.onclose = () => {
          const activeSessionId = transport.sessionId;
          if (activeSessionId) {
            streamableTransports.delete(activeSessionId);
          }
        };

        const server = createSentinelMCP(services);
        await server.connect(transport);
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[Sentinel] MCP Streamable HTTP error:', error);
      if (!res.headersSent) {
        sendMcpError(res, 500, 'Internal server error', -32603);
      }
    }
  });

  app.get('/sse', apiKeyAuth, async (req, res) => {
    try {
      const transport = new SSEServerTransport('/messages', res);
      legacySseTransports.set(transport.sessionId, transport);

      res.on('close', () => {
        legacySseTransports.delete(transport.sessionId);
      });

      const server = createSentinelMCP(services);
      await server.connect(transport);
    } catch (error) {
      console.error('[Sentinel] MCP legacy SSE error:', error);
      if (!res.headersSent) {
        sendMcpError(res, 500, 'Internal server error', -32603);
      }
    }
  });

  app.post('/messages', apiKeyAuth, async (req, res) => {
    try {
      const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : null;
      const transport = sessionId ? legacySseTransports.get(sessionId) : null;

      if (!transport || !(transport instanceof SSEServerTransport)) {
        sendMcpError(res, 400, 'Bad Request: No transport found for the provided session');
        return;
      }

      await transport.handlePostMessage(req, res, req.body);
    } catch (error) {
      console.error('[Sentinel] MCP legacy message error:', error);
      if (!res.headersSent) {
        sendMcpError(res, 500, 'Internal server error', -32603);
      }
    }
  });
}

/**
 * Build the Express app with all middleware and routes.
 * Receives the service layer from the container.
 * Optionally receives adapters for composite health checks.
 */
export function createApp(services, adapters = null) {
  const app = express();

  // ── Security & parsing ──────────────────────
  app.use(helmet());
  app.use(cors({
    origin: process.env.SENTINEL_CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Last-Event-ID', 'X-Request-Id', 'X-Sentinel-SDK', 'X-Sentinel-Key', 'X-Sentinel-Session', 'X-Sentinel-Correlation', 'X-Sentinel-Source'],
  }));
  app.use(compression());
  app.use(express.json({ limit: '60mb' }));
  app.use(requestId);

  // ── Health (before auth — must be public) ───

  // Liveness probe: am I running?
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // Readiness probe: can I serve traffic?
  // Reports component-level status for observability.
  app.get('/ready', async (_req, res) => {
    const components = {};
    let overall = 'healthy';

    // Storage check
    if (adapters?.storage) {
      try {
        const isReady = typeof adapters.storage.pool?.query === 'function';
        if (isReady) {
          await adapters.storage.pool.query('SELECT 1');
          components.storage = { status: 'healthy', type: adapters.storage.pool ? 'postgres' : 'memory' };
        } else {
          components.storage = { status: 'healthy', type: 'memory' };
        }
      } catch {
        components.storage = { status: 'unhealthy', type: 'postgres' };
        overall = 'unhealthy';
      }
    }

    // Trace adapter check (circuit breaker status)
    if (adapters?.trace) {
      const configured = adapters.trace.isConfigured();
      if (typeof adapters.trace.getCircuitStatus === 'function') {
        const circuit = adapters.trace.getCircuitStatus();
        const status = circuit.state === 'OPEN' ? 'degraded'
          : circuit.state === 'HALF_OPEN' ? 'degraded'
          : 'healthy';
        if (status === 'degraded' && overall === 'healthy') overall = 'degraded';
        components.trace = { status, type: 'debugprobe', circuit: circuit.state };
      } else {
        components.trace = { status: configured ? 'healthy' : 'unconfigured', type: configured ? 'active' : 'noop' };
      }
    }

    // Analyzer check (circuit breaker status)
    if (adapters?.analyzer) {
      const configured = adapters.analyzer.isConfigured();
      if (typeof adapters.analyzer.getCircuitStatus === 'function') {
        const circuit = adapters.analyzer.getCircuitStatus();
        const status = circuit.state === 'OPEN' ? 'degraded'
          : circuit.state === 'HALF_OPEN' ? 'degraded'
          : 'healthy';
        if (status === 'degraded' && overall === 'healthy') overall = 'degraded';
        components.analyzer = { status, type: 'manifest', circuit: circuit.state };
      } else {
        components.analyzer = { status: configured ? 'healthy' : 'unconfigured', type: configured ? 'active' : 'noop' };
      }
    }

    // AI adapter check
    if (adapters?.ai) {
      components.ai = {
        status: adapters.ai.isConfigured() ? 'healthy' : 'unconfigured',
        type: adapters.ai.isConfigured() ? 'claude' : 'noop',
      };
    }

    const httpStatus = overall === 'unhealthy' ? 503 : 200;
    res.status(httpStatus).json({
      status: overall,
      timestamp: Date.now(),
      uptime: process.uptime(),
      components,
    });
  });

  // ── Auth & rate limiting ────────────────────
  app.use('/api', apiKeyAuth);
  app.use('/api', rateLimiter({ maxRequests: 200, windowMs: 60_000 }));

  // Higher limit for event ingestion (SDK sends batches frequently)
  app.use('/api/sessions/:id/events', rateLimiter({
    maxRequests: 600,
    windowMs: 60_000,
    keyFn: (req) => req.get('X-Sentinel-Key') || req.ip || 'unknown',
  }));

  // ── API routes ──────────────────────────────
  app.use('/api/sessions', createSessionRoutes(services));
  app.use('/api/findings', createFindingRoutes(services));
  app.use('/api/projects', createProjectRoutes(services));

  // ── MCP Server (Streamable HTTP + legacy SSE) ────
  if (process.env.SENTINEL_MCP_ENABLED === 'true') {
    registerMcpRoutes(app, services);
    console.log('[Sentinel] MCP endpoints enabled at /mcp (Streamable HTTP) and /sse (legacy SSE)');
  }

  // ── Error handling (must be last) ───────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
