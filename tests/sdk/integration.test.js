// ─────────────────────────────────────────────
// Tests — SDK Integration base class
// Verifies the plugin contract.
// 14-dimension coverage: D1 D6
// ─────────────────────────────────────────────

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Integration } from '../../src/sdk/core/integration.js';

describe('Integration base class (D1)', () => {
  it('throws on .name access (must be overridden)', () => {
    const i = new Integration();
    assert.throws(() => i.name, /must be overridden/);
  });

  it('throws on .setup() call (must be overridden)', () => {
    const i = new Integration();
    assert.throws(() => i.setup({}), /must be overridden/);
  });

  it('teardown() is a no-op by default (D7)', () => {
    const i = new Integration();
    i.teardown(); // should not throw
  });
});

describe('Integration subclass contract (D8)', () => {
  it('subclass can implement name, setup, teardown', () => {
    let setupCalled = false;
    let teardownCalled = false;
    class TestIntegration extends Integration {
      get name() { return 'test-plugin'; }
      setup(ctx) { setupCalled = true; this._ctx = ctx; }
      teardown() { teardownCalled = true; }
    }

    const t = new TestIntegration();
    assert.equal(t.name, 'test-plugin');
    t.setup({ reporter: {}, shadowHost: {} });
    assert.ok(setupCalled);
    t.teardown();
    assert.ok(teardownCalled);
  });
});
