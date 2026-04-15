// ─────────────────────────────────────────────
// Sentinel SDK — Integration Base
// All integrations implement this contract.
// Sentry-style modular plugin system.
// ─────────────────────────────────────────────

/**
 * Base class for Sentinel SDK integrations.
 *
 * Integrations are modular plugins that extend capture capabilities.
 * Each integration has a name, a setup() method, and a teardown() method.
 *
 * @example
 *   class MyIntegration extends Integration {
 *     get name() { return 'my-integration'; }
 *     setup({ reporter, shadowHost }) { ... }
 *     teardown() { ... }
 *   }
 */
export class Integration {
  /** Unique name identifying this integration. */
  get name() {
    throw new Error('Integration.name must be overridden');
  }

  /**
   * Called when the integration is added to a Sentinel instance.
   * @param {IntegrationContext} context
   */
  setup(context) {
    throw new Error('Integration.setup() must be overridden');
  }

  /**
   * Called when the Sentinel instance is stopped.
   * Clean up all event listeners, timers, DOM elements, etc.
   */
  teardown() {
    // Default: no-op. Override if cleanup is needed.
  }
}

/**
 * @typedef {object} IntegrationContext
 * @property {import('../reporter.js').Reporter} reporter — event reporter
 * @property {import('./shadow-host.js').ShadowHost} shadowHost — Shadow DOM host
 * @property {object} options — init options passed by the user
 */
