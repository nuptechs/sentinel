// ─────────────────────────────────────────────
// Sentinel — Port: StoragePort
// Contract for persisting sessions, events, findings
// Adapters: PostgreSQL, SQLite, In-Memory
// ─────────────────────────────────────────────

export class StoragePort {
  // ── Sessions ──────────────────────────────

  async createSession(session) {
    throw new Error('StoragePort.createSession() not implemented');
  }

  async getSession(sessionId) {
    throw new Error('StoragePort.getSession() not implemented');
  }

  async updateSession(session) {
    throw new Error('StoragePort.updateSession() not implemented');
  }

  async listSessions(projectId, options) {
    throw new Error('StoragePort.listSessions() not implemented');
  }

  // ── Events ────────────────────────────────

  async storeEvents(events) {
    throw new Error('StoragePort.storeEvents() not implemented');
  }

  async getEvents(sessionId, options) {
    throw new Error('StoragePort.getEvents() not implemented');
  }

  async getEventsByCorrelation(correlationId) {
    throw new Error('StoragePort.getEventsByCorrelation() not implemented');
  }

  // ── Findings ──────────────────────────────

  async createFinding(finding) {
    throw new Error('StoragePort.createFinding() not implemented');
  }

  async getFinding(findingId) {
    throw new Error('StoragePort.getFinding() not implemented');
  }

  async updateFinding(finding) {
    throw new Error('StoragePort.updateFinding() not implemented');
  }

  async listFindings(sessionId, options) {
    throw new Error('StoragePort.listFindings() not implemented');
  }

  async listFindingsByProject(projectId, options) {
    throw new Error('StoragePort.listFindingsByProject() not implemented');
  }

  // ── Finding media blobs (audio/video bytes) ──
  // Kept separate from Finding JSON so binaries are not streamed on every read.
  // Default adapters store bytes in-memory (ephemeral); durable storage is a TODO.

  async storeMedia(row) {
    throw new Error('StoragePort.storeMedia() not implemented');
  }

  async getMedia(mediaId) {
    throw new Error('StoragePort.getMedia() not implemented');
  }

  // ── Traces ─────────────────────────────────

  async storeTrace(trace) {
    throw new Error('StoragePort.storeTrace() not implemented');
  }

  async getTracesBySession(sessionId, options) {
    throw new Error('StoragePort.getTracesBySession() not implemented');
  }

  async getTraceByCorrelation(correlationId) {
    throw new Error('StoragePort.getTraceByCorrelation() not implemented');
  }

  async deleteTracesBefore(date, batchSize) {
    throw new Error('StoragePort.deleteTracesBefore() not implemented');
  }

  // ── Webhook events (optional — enables retry/DLQ) ──

  async createWebhookEvent(row) {
    throw new Error('StoragePort.createWebhookEvent() not implemented');
  }

  async getWebhookEvent(id) {
    throw new Error('StoragePort.getWebhookEvent() not implemented');
  }

  async updateWebhookEvent(id, patch) {
    throw new Error('StoragePort.updateWebhookEvent() not implemented');
  }

  async listWebhookEvents(options) {
    throw new Error('StoragePort.listWebhookEvents() not implemented');
  }

  // ── Probe inbound webhooks (optional) ──

  async recordProbeWebhook(row) {
    throw new Error('StoragePort.recordProbeWebhook() not implemented');
  }

  async listProbeWebhooks(options) {
    throw new Error('StoragePort.listProbeWebhooks() not implemented');
  }

  async countProbeWebhooks() {
    throw new Error('StoragePort.countProbeWebhooks() not implemented');
  }

  // ── Lifecycle ─────────────────────────────

  async initialize() {
    throw new Error('StoragePort.initialize() not implemented');
  }

  async close() {
    throw new Error('StoragePort.close() not implemented');
  }

  isConfigured() {
    return false;
  }
}
