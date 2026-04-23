// ─────────────────────────────────────────────
// Sentinel — Core Service: SessionService
// Orchestrates QA session lifecycle
// Depends ONLY on ports — zero external imports
// ─────────────────────────────────────────────

import { Session } from '../domain/session.js';
import { CaptureEvent } from '../domain/capture-event.js';
import { ValidationError, NotFoundError } from '../errors.js';

export class SessionService {
  /**
   * @param {object} ports
   * @param {import('../ports/storage.port.js').StoragePort} ports.storage
   * @param {import('../ports/trace.port.js').TracePort} [ports.trace]
   */
  constructor({ storage, trace = null }) {
    this.storage = storage;
    this.trace = trace;
  }

  async create({ projectId, userId, userAgent, pageUrl, metadata }) {
    if (!projectId) throw new ValidationError('projectId is required');

    const session = new Session({ projectId, userId, userAgent, pageUrl, metadata });
    await this.storage.createSession(session);

    // Best-effort mirror on the remote trace probe so later getTraces()
    // lands on an existing session id. Never block or fail session
    // creation on a downstream probe hiccup.
    if (this.trace?.ensureRemoteSession) {
      try {
        const res = await this.trace.ensureRemoteSession(session);
        if (res?.ok && res.remoteSessionId) {
          session.metadata = {
            ...(session.metadata || {}),
            debugProbeSessionId: res.remoteSessionId,
          };
          await this.storage.updateSession(session);
        }
      } catch {
        // swallow — TracePort contract is non-throwing, but guard anyway
      }
    }

    return session;
  }

  async get(sessionId) {
    const session = await this.storage.getSession(sessionId);
    if (!session) throw new NotFoundError(`Session ${sessionId} not found`);
    return session;
  }

  /**
   * Get session or auto-create it (for server-to-server probe compatibility).
   * When a probe like DebugProbe sends events with its own session ID,
   * we auto-create the session on first event ingestion.
   */
  async getOrCreate(sessionId, { projectId, source } = {}) {
    const existing = await this.storage.getSession(sessionId);
    if (existing) return existing;

    const session = new Session({
      projectId: projectId || 'auto',
      userId: source || 'probe',
      userAgent: `server-probe/${source || 'unknown'}`,
      pageUrl: null,
      metadata: { autoCreated: true, source: source || 'probe' },
    });
    // Override auto-generated ID with the probe's session ID
    session.id = sessionId;
    await this.storage.createSession(session);
    return session;
  }

  async complete(sessionId) {
    const session = await this.get(sessionId);
    session.complete();
    await this.storage.updateSession(session);
    return session;
  }

  async ingestEvents(sessionId, rawEvents, { autoCreate = false, source } = {}) {
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
      throw new ValidationError('events must be a non-empty array');
    }
    if (rawEvents.length > 500) {
      throw new ValidationError('Maximum 500 events per batch');
    }

    // Auto-create mode: server probes send events without pre-creating sessions
    const session = autoCreate
      ? await this.getOrCreate(sessionId, { source })
      : await this.get(sessionId);

    if (!session.isActive()) {
      throw new ValidationError(`Session ${sessionId} is ${session.status}, cannot ingest events`);
    }

    const events = rawEvents.map(raw => new CaptureEvent({
      sessionId,
      type: raw.type,
      source: raw.source || 'browser',
      timestamp: raw.timestamp || Date.now(),
      payload: raw.payload,
      correlationId: raw.correlationId || null,
    }));

    await this.storage.storeEvents(events);
    return { ingested: events.length };
  }

  async getEvents(sessionId, options = {}) {
    await this.get(sessionId); // ensure session exists
    return this.storage.getEvents(sessionId, options);
  }

  async list(projectId, options = {}) {
    return this.storage.listSessions(projectId, options);
  }
}
