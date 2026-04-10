// ─────────────────────────────────────────────
// Sentinel — Express Server
// ─────────────────────────────────────────────

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';

import { requestId } from './middleware/request-id.js';
import { apiKeyAuth } from './middleware/api-key.js';
import { rateLimiter } from './middleware/rate-limiter.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createFindingRoutes } from './routes/findings.js';
import { createProjectRoutes } from './routes/projects.js';

/**
 * Build the Express app with all middleware and routes.
 * Receives the service layer from the container.
 */
export function createApp(services) {
  const app = express();

  // ── Security & parsing ──────────────────────
  app.use(helmet());
  app.use(cors({
    origin: process.env.SENTINEL_CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Sentinel-SDK', 'X-Sentinel-Key', 'X-Sentinel-Session', 'X-Sentinel-Correlation', 'X-Sentinel-Source'],
  }));
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(requestId);

  // ── Health (before auth — must be public) ───
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
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

  // ── Error handling (must be last) ───────────
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
