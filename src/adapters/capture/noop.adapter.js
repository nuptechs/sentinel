// ─────────────────────────────────────────────
// Sentinel — Adapter: Noop Capture
// Server-side no-op — capture runs in the browser SDK
// (Reporter + Recorder + Annotator)
//
// This adapter exists to satisfy the hexagonal contract.
// The CapturePort methods (start, stop, screenshot) are
// browser-side only; the server receives events via HTTP.
// ─────────────────────────────────────────────

import { CapturePort } from '../../core/ports/capture.port.js';

export class NoopCaptureAdapter extends CapturePort {
  start(_sessionId, _options) {
    // No-op: capture happens in the browser SDK
  }

  async stop() {
    return [];
  }

  async screenshot() {
    return null;
  }

  isConfigured() {
    return false;
  }
}
