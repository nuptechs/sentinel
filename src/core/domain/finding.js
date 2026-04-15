// ─────────────────────────────────────────────
// Sentinel — Core Domain: Finding
// An issue discovered during QA — annotated by
// a human or detected automatically
// ─────────────────────────────────────────────

import { randomUUID } from 'node:crypto';

/**
 * @typedef {'manual' | 'auto_error' | 'auto_performance' | 'auto_network'} FindingSource
 * @typedef {'bug' | 'ux' | 'performance' | 'data' | 'visual' | 'other'} FindingType
 * @typedef {'critical' | 'high' | 'medium' | 'low'} FindingSeverity
 * @typedef {'open' | 'diagnosed' | 'fix_proposed' | 'fix_applied' | 'verified' | 'dismissed'} FindingStatus
 */

export class Finding {
  /**
   * @param {object} props
   * @param {string}  [props.id]
   * @param {string}  props.sessionId
   * @param {string}  props.projectId
   * @param {FindingSource}   props.source
   * @param {FindingType}     props.type
   * @param {FindingSeverity}  [props.severity]
   * @param {FindingStatus}   [props.status]
   * @param {string}  props.title
   * @param {string}  [props.description]
   * @param {string}  [props.pageUrl]
   * @param {string}  [props.cssSelector]
   * @param {string}  [props.screenshotUrl]
   * @param {object}  [props.annotation]       — { x, y, width, height, text }
   * @param {object}  [props.browserContext]    — { errors, network, console }
   * @param {object}  [props.backendContext]    — { traces, queries }
   * @param {object}  [props.codeContext]       — { endpoint, controller, service, callChain }
   * @param {object[]} [props.media]            — [{ id, type: 'audio'|'video', mimeType, size, url }]
   * @param {object}  [props.diagnosis]         — AI diagnosis result
   * @param {object}  [props.correction]        — proposed code change
   * @param {Date}    [props.createdAt]
   * @param {Date}    [props.updatedAt]
   */
  constructor(props) {
    this.id = props.id || randomUUID();
    this.sessionId = props.sessionId;
    this.projectId = props.projectId;
    this.source = props.source;
    this.type = props.type;
    this.severity = props.severity || 'medium';
    this.status = props.status || 'open';
    this.title = props.title;
    this.description = props.description || null;
    this.pageUrl = props.pageUrl || null;
    this.cssSelector = props.cssSelector || null;
    this.screenshotUrl = props.screenshotUrl || null;
    this.annotation = props.annotation || null;
    this.browserContext = props.browserContext || null;
    this.backendContext = props.backendContext || null;
    this.codeContext = props.codeContext || null;
    this.media = props.media || [];
    this.diagnosis = props.diagnosis || null;
    this.correction = props.correction || null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  attachBrowserContext(ctx) {
    this.browserContext = ctx;
    this.updatedAt = new Date();
  }

  attachBackendContext(ctx) {
    this.backendContext = ctx;
    this.updatedAt = new Date();
  }

  attachCodeContext(ctx) {
    this.codeContext = ctx;
    this.updatedAt = new Date();
  }

  addMedia({ id, type, mimeType, size, url }) {
    this.media.push({ id, type, mimeType, size, url, addedAt: new Date().toISOString() });
    this.updatedAt = new Date();
  }

  diagnose(diagnosis) {
    this.diagnosis = diagnosis;
    this.status = 'diagnosed';
    this.updatedAt = new Date();
  }

  proposeFix(correction) {
    this.correction = correction;
    this.status = 'fix_proposed';
    this.updatedAt = new Date();
  }

  applyFix() {
    this.status = 'fix_applied';
    this.updatedAt = new Date();
  }

  verify() {
    this.status = 'verified';
    this.updatedAt = new Date();
  }

  dismiss() {
    this.status = 'dismissed';
    this.updatedAt = new Date();
  }

  isEnriched() {
    return !!(this.browserContext || this.backendContext || this.codeContext);
  }

  toJSON() {
    return {
      id: this.id,
      sessionId: this.sessionId,
      projectId: this.projectId,
      source: this.source,
      type: this.type,
      severity: this.severity,
      status: this.status,
      title: this.title,
      description: this.description,
      pageUrl: this.pageUrl,
      cssSelector: this.cssSelector,
      screenshotUrl: this.screenshotUrl,
      annotation: this.annotation,
      browserContext: this.browserContext,
      backendContext: this.backendContext,
      codeContext: this.codeContext,
      media: this.media,
      diagnosis: this.diagnosis,
      correction: this.correction,
      createdAt: this.createdAt.toISOString(),
      updatedAt: this.updatedAt.toISOString(),
    };
  }
}
