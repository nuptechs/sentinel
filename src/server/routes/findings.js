// ─────────────────────────────────────────────
// Sentinel — Findings API
// ─────────────────────────────────────────────

import { Router } from 'express';
import { randomUUID as _randomUUID } from 'node:crypto';
import { asyncHandler } from '../middleware/error-handler.js';
import { ValidationError } from '../../core/errors.js';

async function autoProcessFinding(services, findingId) {
  if (process.env.SENTINEL_AUTO_DIAGNOSE !== 'true') return;

  try {
    await services.diagnosis.diagnose(findingId);

    if (process.env.SENTINEL_AUTO_CORRECT === 'true') {
      await services.correction.generateCorrection(findingId);
    }
  } catch (err) {
    console.warn(`[Sentinel] Auto-processing failed for finding ${findingId}:`, err.message);
  }
}

export function createFindingRoutes(services) {
  const router = Router();

  // POST /api/findings — Create a finding (from annotation or auto-detect)
  router.post('/', asyncHandler(async (req, res) => {
    const { sessionId, projectId, annotation, browserContext, type, severity, source,
            title, description, pageUrl, cssSelector, screenshotUrl,
            correlationId, debugProbeSessionId, manifestProjectId, manifestRunId } = req.body;

    if (!sessionId?.trim()) throw new ValidationError('sessionId is required');
    if (!projectId?.trim()) throw new ValidationError('projectId is required');

    // Derive title from annotation.description if not explicitly provided
    const derivedTitle = title || annotation?.description?.slice(0, 120) || 'Untitled finding';

    const finding = await services.findings.create({
      sessionId: sessionId.trim(),
      projectId: projectId.trim(),
      title: derivedTitle,
      description: description || annotation?.description,
      pageUrl: pageUrl || annotation?.url,
      cssSelector,
      screenshotUrl: screenshotUrl || annotation?.screenshot,
      annotation,
      browserContext,
      type: type || 'bug',
      severity: severity || 'medium',
      source: source || 'manual',
      correlationId: correlationId || annotation?.correlationId || null,
      debugProbeSessionId: debugProbeSessionId || null,
      manifestProjectId: manifestProjectId || null,
      manifestRunId: manifestRunId || null,
    });

    queueMicrotask(() => {
      void autoProcessFinding(services, finding.id);
    });

    res.status(201).json({ success: true, data: finding.toJSON() });
  }));

  // GET /api/findings/:id — Get finding details
  router.get('/:id', asyncHandler(async (req, res) => {
    const finding = await services.findings.get(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // GET /api/findings — List findings by session or project
  router.get('/', asyncHandler(async (req, res) => {
    const { sessionId, projectId, status, limit = '50', offset = '0' } = req.query;

    if (!sessionId && !projectId) {
      throw new ValidationError('sessionId or projectId query param is required');
    }

    const opts = {
      status,
      limit: Math.min(parseInt(limit, 10) || 50, 200),
      offset: parseInt(offset, 10) || 0,
    };

    const findings = sessionId
      ? await services.findings.listBySession(sessionId, opts)
      : await services.findings.listByProject(projectId, opts);

    res.json({ success: true, data: findings.map(f => f.toJSON()) });
  }));

  // POST /api/findings/:id/diagnose — Trigger AI diagnosis
  router.post('/:id/diagnose', asyncHandler(async (req, res) => {
    const finding = await services.diagnosis.diagnose(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/correct — Generate AI correction
  router.post('/:id/correct', asyncHandler(async (req, res) => {
    const finding = await services.correction.generateCorrection(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/clarify — AI Q&A about a finding
  router.post('/:id/clarify', asyncHandler(async (req, res) => {
    const { question } = req.body;
    if (!question?.trim()) throw new ValidationError('question is required');

    const answer = await services.correction.clarify(req.params.id, question.trim());
    res.json({ success: true, data: { answer } });
  }));

  // POST /api/findings/:id/dismiss — Dismiss a finding
  router.post('/:id/dismiss', asyncHandler(async (req, res) => {
    const { reason } = req.body;
    const finding = await services.findings.dismiss(req.params.id, reason);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/apply — Mark correction as applied
  router.post('/:id/apply', asyncHandler(async (req, res) => {
    const finding = await services.findings.markApplied(req.params.id);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/verify — Mark finding as verified
  router.post('/:id/verify', asyncHandler(async (req, res) => {
    const { verified } = req.body;
    const finding = await services.findings.verify(req.params.id, verified !== false);
    res.json({ success: true, data: finding.toJSON() });
  }));

  // POST /api/findings/:id/push — Push finding to issue tracker
  router.post('/:id/push', asyncHandler(async (req, res) => {
    if (!services.integration) throw new ValidationError('Integration service not available');
    const result = await services.integration.pushToTracker(req.params.id);
    res.json({ success: true, data: result });
  }));

  // POST /api/findings/suggest-title — AI-powered title suggestion
  router.post('/suggest-title', asyncHandler(async (req, res) => {
    if (!services.integration) throw new ValidationError('Integration service not available');
    const { description, screenshot, element, pageUrl, browserContext } = req.body;
    const suggestion = await services.integration.suggestTitle({ description, screenshot, element, pageUrl, browserContext });
    res.json({ success: true, data: suggestion });
  }));

  // POST /api/findings/:id/media — Upload audio/video blob for a finding
  router.post('/:id/media', asyncHandler(async (req, res) => {
    const finding = await services.findings.get(req.params.id);

    const { type, mimeType, data } = req.body;
    if (!type || !['audio', 'video'].includes(type)) throw new ValidationError('type must be "audio" or "video"');
    if (!data) throw new ValidationError('data (base64-encoded blob) is required');

    // Validate size: 10MB audio, 50MB video
    const maxBytes = type === 'audio' ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    const sizeEstimate = Math.ceil((data.length * 3) / 4);
    if (sizeEstimate > maxBytes) {
      throw new ValidationError(`${type} exceeds max size of ${maxBytes / (1024 * 1024)}MB`);
    }

    const mediaId = _randomUUID();
    finding.addMedia({
      id: mediaId,
      type,
      mimeType: mimeType || (type === 'audio' ? 'audio/webm' : 'video/webm'),
      size: sizeEstimate,
      url: `/api/findings/${finding.id}/media/${mediaId}`,
    });
    await services.findings.storage.updateFinding(finding);

    res.status(201).json({
      success: true,
      data: { mediaId, type, size: sizeEstimate, url: `/api/findings/${finding.id}/media/${mediaId}` },
    });
  }));

  return router;
}
