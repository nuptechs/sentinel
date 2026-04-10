// ─────────────────────────────────────────────
// Sentinel — Sessions API
// ─────────────────────────────────────────────

import { Router } from 'express';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';

export function createSessionRoutes(services) {
  const router = Router();

  // POST /api/sessions — Start a new QA session
  router.post('/', asyncHandler(async (req, res) => {
    const { projectId, userId, userAgent, pageUrl, metadata } = req.body;
    if (!projectId?.trim()) throw new ValidationError('projectId is required');

    const session = await services.sessions.create({
      projectId: projectId.trim(),
      userId: userId?.trim() || 'anonymous',
      userAgent: userAgent || req.get('user-agent'),
      pageUrl,
      metadata,
    });

    res.status(201).json({ success: true, data: session.toJSON() });
  }));

  // GET /api/sessions/:id — Get session details
  router.get('/:id', asyncHandler(async (req, res) => {
    const session = await services.sessions.get(req.params.id);
    res.json({ success: true, data: session.toJSON() });
  }));

  // GET /api/sessions — List sessions by project
  router.get('/', asyncHandler(async (req, res) => {
    const { projectId, limit = '50', offset = '0' } = req.query;
    if (!projectId?.trim()) throw new ValidationError('projectId query param is required');

    const sessions = await services.sessions.list(projectId.trim(), {
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0,
    });

    res.json({ success: true, data: sessions.map(s => s.toJSON()) });
  }));

  // POST /api/sessions/:id/events — Ingest capture events (batch)
  // Supports auto-create mode for server probes (X-Sentinel-Source header)
  router.post('/:id/events', asyncHandler(async (req, res) => {
    const { events } = req.body;
    if (!Array.isArray(events) || events.length === 0) {
      throw new ValidationError('events must be a non-empty array');
    }

    const source = req.get('X-Sentinel-Source');
    const autoCreate = !!source; // server probes set this header

    const result = await services.sessions.ingestEvents(req.params.id, events, { autoCreate, source });
    res.status(201).json({ success: true, data: { count: result.ingested } });
  }));

  // GET /api/sessions/:id/events — Get session events
  router.get('/:id/events', asyncHandler(async (req, res) => {
    const { type, limit = '500' } = req.query;
    const events = await services.sessions.getEvents(req.params.id, {
      type,
      limit: Math.min(parseInt(limit, 10) || 500, 2000),
    });

    res.json({ success: true, data: events.map(e => e.toJSON()) });
  }));

  // POST /api/sessions/:id/complete — End a session
  router.post('/:id/complete', asyncHandler(async (req, res) => {
    const session = await services.sessions.complete(req.params.id);
    res.json({ success: true, data: session.toJSON() });
  }));

  return router;
}
