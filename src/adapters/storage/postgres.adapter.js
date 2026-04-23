// ─────────────────────────────────────────────
// Sentinel — Adapter: PostgreSQL Storage
// Implements StoragePort with pg.Pool
// ─────────────────────────────────────────────

import { StoragePort } from '../../core/ports/storage.port.js';
import { Session } from '../../core/domain/session.js';
import { Finding } from '../../core/domain/finding.js';
import { CaptureEvent } from '../../core/domain/capture-event.js';
import { runMigrations } from './migrations.js';

export class PostgresStorageAdapter extends StoragePort {
  /**
   * @param {object} options
   * @param {import('pg').Pool} options.pool — a pg Pool instance
   */
  constructor({ pool }) {
    super();
    this.pool = pool;
  }

  // ── Sessions ──────────────────────────────

  async createSession(session) {
    await this.pool.query(
      `INSERT INTO sentinel_sessions (id, project_id, user_id, user_agent, page_url, status, metadata, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [session.id, session.projectId, session.userId, session.userAgent,
       session.pageUrl, session.status, JSON.stringify(session.metadata),
       session.createdAt, session.updatedAt]
    );
    return session;
  }

  async getSession(sessionId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_sessions WHERE id = $1`, [sessionId]
    );
    return rows[0] ? this._mapSession(rows[0]) : null;
  }

  async updateSession(session) {
    await this.pool.query(
      `UPDATE sentinel_sessions
       SET status = $2, metadata = $3, updated_at = $4, completed_at = $5
       WHERE id = $1`,
      [session.id, session.status, JSON.stringify(session.metadata),
       session.updatedAt, session.completedAt]
    );
    return session;
  }

  async listSessions(projectId, { limit = 50, offset = 0, status } = {}) {
    const conditions = ['project_id = $1'];
    const params = [projectId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_sessions
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );
    return rows.map(r => this._mapSession(r));
  }

  // ── Events ────────────────────────────────

  async storeEvents(events) {
    if (events.length === 0) return;

    const values = [];
    const params = [];
    let idx = 1;

    for (const e of events) {
      values.push(`($${idx}, $${idx+1}, $${idx+2}, $${idx+3}, $${idx+4}, $${idx+5}, $${idx+6})`);
      params.push(e.id, e.sessionId, e.type, e.source, e.timestamp, JSON.stringify(e.payload), e.correlationId);
      idx += 7;
    }

    await this.pool.query(
      `INSERT INTO sentinel_events (id, session_id, type, source, timestamp, payload, correlation_id)
       VALUES ${values.join(', ')}`,
      params
    );
  }

  async getEvents(sessionId, { type, limit = 1000, since, until } = {}) {
    const conditions = ['session_id = $1'];
    const params = [sessionId];
    let idx = 2;

    if (type) {
      conditions.push(`type = $${idx}`);
      params.push(type);
      idx++;
    }
    if (since) {
      conditions.push(`timestamp >= $${idx}`);
      params.push(since);
      idx++;
    }
    if (until) {
      conditions.push(`timestamp <= $${idx}`);
      params.push(until);
      idx++;
    }

    params.push(limit);
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_events
       WHERE ${conditions.join(' AND ')}
       ORDER BY timestamp ASC
       LIMIT $${idx}`,
      params
    );
    return rows.map(r => this._mapEvent(r));
  }

  async getEventsByCorrelation(correlationId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_events WHERE correlation_id = $1 ORDER BY timestamp ASC`,
      [correlationId]
    );
    return rows.map(r => this._mapEvent(r));
  }

  // ── Findings ──────────────────────────────

  async createFinding(finding) {
    await this.pool.query(
      `INSERT INTO sentinel_findings
       (id, session_id, project_id, source, type, severity, status,
        title, description, page_url, css_selector, screenshot_url,
        annotation, browser_context, backend_context, code_context,
        diagnosis, correction, created_at, updated_at,
        correlation_id, debug_probe_session_id, manifest_project_id, manifest_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [
        finding.id, finding.sessionId, finding.projectId,
        finding.source, finding.type, finding.severity, finding.status,
        finding.title, finding.description, finding.pageUrl,
        finding.cssSelector, finding.screenshotUrl,
        this._json(finding.annotation), this._json(finding.browserContext),
        this._json(finding.backendContext), this._json(finding.codeContext),
        this._json(finding.diagnosis), this._json(finding.correction),
        finding.createdAt, finding.updatedAt,
        finding.correlationId || null,
        finding.debugProbeSessionId || null,
        finding.manifestProjectId || null,
        finding.manifestRunId || null,
      ]
    );
    return finding;
  }

  async getFinding(findingId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_findings WHERE id = $1`, [findingId]
    );
    return rows[0] ? this._mapFinding(rows[0]) : null;
  }

  async updateFinding(finding) {
    await this.pool.query(
      `UPDATE sentinel_findings
       SET status = $2, severity = $3, description = $4,
           browser_context = $5, backend_context = $6, code_context = $7,
           diagnosis = $8, correction = $9, updated_at = $10
       WHERE id = $1`,
      [
        finding.id, finding.status, finding.severity, finding.description,
        this._json(finding.browserContext), this._json(finding.backendContext),
        this._json(finding.codeContext), this._json(finding.diagnosis),
        this._json(finding.correction), finding.updatedAt,
      ]
    );
    return finding;
  }

  async listFindings(sessionId, { limit = 100, offset = 0, status } = {}) {
    const conditions = ['session_id = $1'];
    const params = [sessionId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_findings
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );
    return rows.map(r => this._mapFinding(r));
  }

  async listFindingsByProject(projectId, { limit = 100, offset = 0, status } = {}) {
    const conditions = ['project_id = $1'];
    const params = [projectId];
    let idx = 2;

    if (status) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }

    params.push(limit, offset);
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_findings
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      params
    );
    return rows.map(r => this._mapFinding(r));
  }

  // ── Traces ────────────────────────────────

  async storeTrace(trace) {
    await this.pool.query(
      `INSERT INTO sentinel_traces
       (session_id, correlation_id, trace_id, span_id, request, response, queries, duration_ms, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (correlation_id) DO UPDATE SET
         session_id = EXCLUDED.session_id,
         trace_id = COALESCE(EXCLUDED.trace_id, sentinel_traces.trace_id),
         span_id = COALESCE(EXCLUDED.span_id, sentinel_traces.span_id),
         request = COALESCE(EXCLUDED.request, sentinel_traces.request),
         response = COALESCE(EXCLUDED.response, sentinel_traces.response),
         queries = EXCLUDED.queries,
         duration_ms = EXCLUDED.duration_ms,
         created_at = LEAST(sentinel_traces.created_at, EXCLUDED.created_at)`,
      [
        trace.sessionId,
        trace.correlationId,
        trace.traceId || null,
        trace.spanId || null,
        this._json(trace.request),
        this._json(trace.response),
        JSON.stringify(trace.queries || []),
        trace.response?.durationMs ?? trace.durationMs ?? null,
        trace.createdAt ? new Date(trace.createdAt) : new Date(),
      ]
    );
  }

  async getTracesBySession(sessionId, { since, until, limit = 500 } = {}) {
    const conditions = ['session_id = $1'];
    const params = [sessionId];
    let idx = 2;

    if (since) {
      conditions.push(`created_at >= $${idx}`);
      params.push(new Date(since));
      idx++;
    }
    if (until) {
      conditions.push(`created_at <= $${idx}`);
      params.push(new Date(until));
      idx++;
    }

    params.push(limit);
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_traces
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC
       LIMIT $${idx}`,
      params
    );
    return rows.map(r => this._mapTrace(r));
  }

  async getTraceByCorrelation(correlationId) {
    const { rows } = await this.pool.query(
      `SELECT * FROM sentinel_traces WHERE correlation_id = $1`,
      [correlationId]
    );
    return rows[0] ? this._mapTrace(rows[0]) : null;
  }

  async deleteTracesBefore(date, batchSize = 500) {
    const result = await this.pool.query(
      `DELETE FROM sentinel_traces
       WHERE id IN (
         SELECT id FROM sentinel_traces
         WHERE created_at < $1
         LIMIT $2
       )`,
      [new Date(date), batchSize]
    );
    return result.rowCount || 0;
  }

  // ── Lifecycle ─────────────────────────────

  async initialize() {
    await runMigrations(this.pool);
  }

  async close() {
    await this.pool.end();
  }

  isConfigured() {
    return !!this.pool;
  }

  // ── Mappers ───────────────────────────────

  _json(val) {
    return val ? JSON.stringify(val) : null;
  }

  _mapSession(row) {
    return new Session({
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      userAgent: row.user_agent,
      pageUrl: row.page_url,
      status: row.status,
      metadata: row.metadata || {},
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    });
  }

  _mapEvent(row) {
    return new CaptureEvent({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      source: row.source,
      timestamp: Number(row.timestamp),
      payload: row.payload,
      correlationId: row.correlation_id,
    });
  }

  _mapFinding(row) {
    return new Finding({
      id: row.id,
      sessionId: row.session_id,
      projectId: row.project_id,
      source: row.source,
      type: row.type,
      severity: row.severity,
      status: row.status,
      title: row.title,
      description: row.description,
      pageUrl: row.page_url,
      cssSelector: row.css_selector,
      screenshotUrl: row.screenshot_url,
      annotation: row.annotation,
      browserContext: row.browser_context,
      backendContext: row.backend_context,
      codeContext: row.code_context,
      diagnosis: row.diagnosis,
      correction: row.correction,
      correlationId: row.correlation_id || null,
      debugProbeSessionId: row.debug_probe_session_id || null,
      manifestProjectId: row.manifest_project_id || null,
      manifestRunId: row.manifest_run_id || null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  _mapTrace(row) {
    return {
      correlationId: row.correlation_id,
      sessionId: row.session_id,
      traceId: row.trace_id || null,
      spanId: row.span_id || null,
      request: row.request || null,
      response: row.response || null,
      queries: row.queries || [],
      durationMs: row.duration_ms != null ? Number(row.duration_ms) : null,
      createdAt: new Date(row.created_at).getTime(),
    };
  }
}
