// ─────────────────────────────────────────────
// Sentinel — Core Service: FindingService
// CRUD + enrichment for QA findings
// Depends ONLY on ports — zero external imports
// ─────────────────────────────────────────────

import { Finding } from '../domain/finding.js';
import { ValidationError, NotFoundError } from '../errors.js';
import { findingsCreatedTotal } from '../../observability/metrics.js';

export class FindingService {
  /**
   * @param {object} ports
   * @param {import('../ports/storage.port.js').StoragePort} ports.storage
   */
  constructor({ storage }) {
    this.storage = storage;
  }

  async create({
    sessionId, projectId, source, type, severity,
    title, description, pageUrl, cssSelector,
    screenshotUrl, annotation, browserContext,
    correlationId, debugProbeSessionId, manifestProjectId, manifestRunId,
  }) {
    if (!sessionId) throw new ValidationError('sessionId is required');
    if (!projectId) throw new ValidationError('projectId is required');
    if (!title?.trim()) throw new ValidationError('title is required');
    if (!source) throw new ValidationError('source is required');
    if (!type) throw new ValidationError('type is required');

    // Backfill debugProbeSessionId from session.metadata when not provided.
    // SessionService stores the remote probe session id there during startSession.
    let resolvedDebugProbeSessionId = debugProbeSessionId || null;
    if (!resolvedDebugProbeSessionId) {
      try {
        const session = await this.storage.getSession(sessionId);
        if (session?.metadata?.debugProbeSessionId) {
          resolvedDebugProbeSessionId = session.metadata.debugProbeSessionId;
        }
      } catch {
        // non-fatal — proceed without backfill
      }
    }

    const finding = new Finding({
      sessionId, projectId, source, type, severity,
      title, description, pageUrl, cssSelector,
      screenshotUrl, annotation, browserContext,
      correlationId: correlationId || null,
      debugProbeSessionId: resolvedDebugProbeSessionId,
      manifestProjectId: manifestProjectId || null,
      manifestRunId: manifestRunId || null,
    });

    await this.storage.createFinding(finding);
    findingsCreatedTotal.inc({ source: String(source), type: String(type) });
    return finding;
  }

  async get(findingId) {
    const finding = await this.storage.getFinding(findingId);
    if (!finding) throw new NotFoundError(`Finding ${findingId} not found`);
    return finding;
  }

  async listBySession(sessionId, options = {}) {
    return this.storage.listFindings(sessionId, options);
  }

  async listByProject(projectId, options = {}) {
    return this.storage.listFindingsByProject(projectId, options);
  }

  async dismiss(findingId) {
    const finding = await this.get(findingId);
    finding.dismiss();
    await this.storage.updateFinding(finding);
    return finding;
  }

  async markApplied(findingId) {
    const finding = await this.get(findingId);
    finding.applyFix();
    await this.storage.updateFinding(finding);
    return finding;
  }

  async verify(findingId) {
    const finding = await this.get(findingId);
    finding.verify();
    await this.storage.updateFinding(finding);
    return finding;
  }
}
