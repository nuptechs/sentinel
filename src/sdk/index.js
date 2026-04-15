// ─────────────────────────────────────────────
// Sentinel SDK — Main entry point
// Sentry-style modular integration architecture.
//
// Usage:
//   import { init, RecorderIntegration, MediaIntegration, AnnotatorIntegration } from '@nuptech/sentinel/sdk';
//
//   const sentinel = await init({
//     serverUrl: 'https://sentinel.example.com',
//     projectId: 'my-app',
//     integrations: [
//       new RecorderIntegration({ captureDOM: true, captureNetwork: true }),
//       new MediaIntegration(),
//       new AnnotatorIntegration({ position: 'bottom-right' }),
//     ],
//   });
//
//   // Programmatic finding:
//   sentinel.report({ description: 'Bug', severity: 'high' });
//
//   // Stop everything:
//   await sentinel.stop();
// ─────────────────────────────────────────────

import { Reporter } from './reporter.js';
import { ShadowHost } from './core/shadow-host.js';

// Re-export building blocks
export { Reporter } from './reporter.js';
export { ShadowHost } from './core/shadow-host.js';
export { BatchSender } from './core/batch-sender.js';
export { Integration } from './core/integration.js';
export { RecorderIntegration } from './integrations/recorder.integration.js';
export { MediaIntegration } from './integrations/media.integration.js';
export { AnnotatorIntegration } from './integrations/annotator.integration.js';

// Legacy — kept for backwards compatibility
export { Recorder } from './recorder.js';
export { Annotator as AnnotatorV2 } from './annotator.v2.js';

/**
 * Initialize Sentinel with modular integrations.
 *
 * @param {Object} options
 * @param {string} options.serverUrl - Sentinel server URL
 * @param {string} options.projectId - Project identifier
 * @param {string} [options.userId] - Current user email/id
 * @param {string} [options.apiKey] - API key for auth
 * @param {Object} [options.metadata] - Extra session metadata
 * @param {Integration[]} [options.integrations] - Modular integrations
 * @param {number} [options.batchSize=50] - Events per batch
 * @param {number} [options.flushInterval=3000] - Flush period in ms
 * @param {number} [options.bufferCapacity=10000] - Ring buffer capacity
 *
 * @returns {Promise<SentinelInstance>}
 */
export async function init({
  serverUrl,
  projectId,
  userId,
  apiKey,
  metadata,
  integrations = [],
  batchSize,
  flushInterval,
  bufferCapacity,
  // Legacy options — auto-create integrations if no explicit integrations provided
  captureDOM,
  captureNetwork,
  captureConsole,
  captureErrors,
  sampling,
  annotator,
  annotatorPosition,
} = {}) {
  if (!serverUrl) throw new Error('Sentinel: serverUrl is required');
  if (!projectId) throw new Error('Sentinel: projectId is required');

  // If no explicit integrations, build defaults from legacy options
  if (integrations.length === 0) {
    integrations = await _buildDefaultIntegrations({
      captureDOM, captureNetwork, captureConsole, captureErrors,
      sampling, annotator, annotatorPosition,
    });
  }

  // Create reporter with BatchSender-backed transport
  const reporter = new Reporter({ serverUrl, projectId, apiKey, batchSize, flushInterval, bufferCapacity });
  const session = await reporter.startSession({ userId, metadata });

  // Create shared Shadow DOM host for UI integrations
  const shadowHost = new ShadowHost();

  // Store integration instances for cross-integration discovery
  const integrationInstances = [...integrations];

  // Context shared with all integrations
  const context = {
    reporter,
    shadowHost,
    options: {
      serverUrl,
      projectId,
      apiKey,
      _integrationInstances: integrationInstances,
    },
  };

  // Setup all integrations in order
  for (const integration of integrationInstances) {
    try {
      const result = integration.setup(context);
      if (result && typeof result.then === 'function') await result;
    } catch (err) {
      console.warn(`[Sentinel] Integration "${integration.name}" setup failed:`, err.message);
    }
  }

  // Cleanup on page unload
  const onBeforeUnload = () => reporter.destroy();
  window.addEventListener('beforeunload', onBeforeUnload);

  /** @type {SentinelInstance} */
  const instance = {
    session,
    reporter,
    shadowHost,
    integrations: integrationInstances,

    /** Get an integration by name */
    getIntegration(name) {
      return integrationInstances.find(i => i.name === name) || null;
    },

    /** Add an integration after init */
    addIntegration(integration) {
      integrationInstances.push(integration);
      try {
        const result = integration.setup(context);
        if (result && typeof result.then === 'function') return result;
      } catch (err) {
        console.warn(`[Sentinel] Integration "${integration.name}" setup failed:`, err.message);
      }
    },

    /** Report a finding programmatically */
    report(finding) {
      return reporter.reportFinding({
        ...finding,
        source: finding.source || 'programmatic',
        type: finding.type || 'bug',
        severity: finding.severity || 'medium',
      });
    },

    /** Stop all integrations, flush events, end session */
    async stop() {
      for (const integration of [...integrationInstances].reverse()) {
        try { integration.teardown(); } catch { /* ignore */ }
      }
      shadowHost.unmount();
      window.removeEventListener('beforeunload', onBeforeUnload);
      await reporter.endSession();
    },
  };

  return instance;
}

/**
 * Build default integrations from legacy options.
 * Lazily imports integration classes to support tree-shaking.
 */
async function _buildDefaultIntegrations({
  captureDOM = true, captureNetwork = true, captureConsole = true,
  captureErrors = true, sampling, annotator = true, annotatorPosition,
} = {}) {
  const integrations = [];

  const { RecorderIntegration } = await import('./integrations/recorder.integration.js');
  integrations.push(new RecorderIntegration({
    captureDOM, captureNetwork, captureConsole, captureErrors, sampling,
  }));

  const { MediaIntegration } = await import('./integrations/media.integration.js');
  integrations.push(new MediaIntegration());

  if (annotator) {
    const { AnnotatorIntegration } = await import('./integrations/annotator.integration.js');
    integrations.push(new AnnotatorIntegration({ position: annotatorPosition }));
  }

  return integrations;
}
