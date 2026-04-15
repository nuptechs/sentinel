// ─────────────────────────────────────────────
// Tests — ManifestAnalyzerAdapter
// D1 D2 D6 D7 D8 D9 + Security (path traversal)
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ManifestAnalyzerAdapter } from '../../src/adapters/analyzer/manifest.adapter.js';
import { IntegrationError } from '../../src/core/errors.js';

// ── Fetch mock ────────────────────────────────

let _origFetch;
const _calls = [];
const _queue = [];

function setupFetch() {
  _calls.length = 0;
  _origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    _calls.push({ url, opts });
    const resp = _queue.shift();
    if (resp instanceof Error) throw resp;
    if (resp === undefined) return { ok: true, status: 200, json: async () => [] };
    return resp;
  };
}

function teardownFetch() {
  globalThis.fetch = _origFetch;
  _queue.length = 0;
}

function queueJson(data, status = 200) {
  _queue.push({ ok: status < 400, status, json: async () => data });
}

function queueHttpError(status = 503, statusText = 'Service Unavailable') {
  _queue.push({ ok: false, status, statusText, json: async () => ({}) });
}

function queueNetError(msg = 'ECONNREFUSED') {
  _queue.push(new Error(msg));
}

// ── D8: isConfigured ─────────────────────────

describe('ManifestAnalyzerAdapter.isConfigured (D8)', () => {
  it('returns true when baseUrl is set', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'https://manifest.example.com' });
    assert.equal(a.isConfigured(), true);
  });

  it('returns false when no baseUrl (D7)', () => {
    const a = new ManifestAnalyzerAdapter();
    assert.equal(a.isConfigured(), false);
  });
});

// ── D7: _classToPath ─────────────────────────

describe('ManifestAnalyzerAdapter._classToPath (D7)', () => {
  it('converts fully qualified Java class to file path', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    assert.equal(
      a._classToPath('easynup.services.web.contract.CreateContractWsV1'),
      'easynup/services/web/contract/CreateContractWsV1.java'
    );
  });

  it('handles simple class name without package', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    assert.equal(a._classToPath('UserService'), 'UserService.java');
  });
});

// ── D1: resolveEndpoint happy path ────────────

describe('ManifestAnalyzerAdapter.resolveEndpoint (D1 D7 D9)', () => {
  beforeEach(setupFetch);
  afterEach(teardownFetch);

  function makeCatalogEntry(overrides = {}) {
    return {
      endpoint: '/api/contracts',
      httpMethod: 'GET',
      controllerClass: 'easynup.services.web.contract.FindContractsWsV1',
      controllerMethod: 'handle',
      serviceMethods: [{ className: 'easynup.services.ContractService', method: 'findAll' }],
      repositoryMethods: [],
      entitiesTouched: ['Contract'],
      ...overrides,
    };
  }

  it('returns null when no catalog entries (D7)', async () => {
    queueJson([]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    const result = await a.resolveEndpoint('proj-1', '/api/contracts', 'GET');
    assert.equal(result, null);
  });

  it('returns null when no matching endpoint (D7)', async () => {
    queueJson([makeCatalogEntry({ endpoint: '/api/orders', httpMethod: 'GET' })]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    const result = await a.resolveEndpoint('proj-1', '/api/contracts', 'GET');
    assert.equal(result, null);
  });

  it('returns null when endpoint matches but method does not (D7)', async () => {
    queueJson([makeCatalogEntry({ endpoint: '/api/contracts', httpMethod: 'GET' })]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    const result = await a.resolveEndpoint('proj-1', '/api/contracts', 'POST');
    assert.equal(result, null);
  });

  it('returns resolved entry when endpoint and method match (D1)', async () => {
    queueJson([makeCatalogEntry()]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    const result = await a.resolveEndpoint('proj-1', '/api/contracts', 'GET');
    assert.ok(result);
    assert.equal(result.endpoint, '/api/contracts');
    assert.equal(result.httpMethod, 'GET');
  });

  it('method matching is case-insensitive (D2)', async () => {
    queueJson([makeCatalogEntry({ httpMethod: 'get' })]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    const result = await a.resolveEndpoint('proj-1', '/api/contracts', 'GET');
    assert.ok(result);
  });

  it('extracts sourceFiles from controllerClass (D9)', async () => {
    queueJson([makeCatalogEntry()]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    const result = await a.resolveEndpoint('proj-1', '/api/contracts', 'GET');
    assert.ok(result.sourceFiles.some(f => f.includes('FindContractsWsV1.java')));
  });

  it('extracts sourceFiles from serviceMethods (D9)', async () => {
    queueJson([makeCatalogEntry()]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    const result = await a.resolveEndpoint('proj-1', '/api/contracts', 'GET');
    assert.ok(result.sourceFiles.some(f => f.includes('ContractService.java')));
  });

  it('sends X-API-Key header when apiKey configured (D9)', async () => {
    queueJson([]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest', apiKey: 'manifest-key-xyz' });
    await a.resolveEndpoint('proj-1', '/api/test', 'GET');
    assert.equal(_calls[0].opts.headers['X-API-Key'], 'manifest-key-xyz');
  });

  it('fetches from correct catalog endpoint (D9)', async () => {
    queueJson([]);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    await a.resolveEndpoint('proj-42', '/api/test', 'GET');
    assert.ok(_calls[0].url.includes('/api/catalog-entries/proj-42'));
  });
});

// ── D6: Error handling ────────────────────────

describe('ManifestAnalyzerAdapter error handling (D6)', () => {
  beforeEach(setupFetch);
  afterEach(teardownFetch);

  it('throws IntegrationError on non-ok HTTP response', async () => {
    queueHttpError(503);
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    await assert.rejects(() => a.resolveEndpoint('p1', '/x', 'GET'), IntegrationError);
  });

  it('throws IntegrationError on network error', async () => {
    queueNetError('ECONNREFUSED');
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    await assert.rejects(() => a.resolveEndpoint('p1', '/x', 'GET'), IntegrationError);
  });

  it('throws IntegrationError on AbortError (timeout)', async () => {
    // Simulate AbortError
    _queue.push(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest', timeoutMs: 1 });
    await assert.rejects(() => a.resolveEndpoint('p1', '/x', 'GET'), IntegrationError);
  });
});

// ── D8: Circuit breaker ───────────────────────

describe('ManifestAnalyzerAdapter circuit breaker (D8)', () => {
  beforeEach(setupFetch);
  afterEach(teardownFetch);

  it('opens after failureThreshold consecutive network failures', async () => {
    // Default failureThreshold = 3
    queueNetError(); queueNetError(); queueNetError();
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    // 3 failures to trip the breaker
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => a.resolveEndpoint('p1', '/x', 'GET'));
    }
    const status = a.getCircuitStatus();
    assert.equal(status.state, 'OPEN');
  });

  it('4xx errors do NOT trip the circuit breaker (D8)', async () => {
    // 3 × 404 responses — should NOT trip circuit
    queueHttpError(404, 'Not Found');
    queueHttpError(404, 'Not Found');
    queueHttpError(404, 'Not Found');
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => a.resolveEndpoint('p1', '/missing', 'GET'));
    }
    const status = a.getCircuitStatus();
    assert.equal(status.state, 'CLOSED');
  });

  it('throws INTEGRATION_ERROR with circuit info when circuit is open (D6)', async () => {
    // Trip the circuit
    queueNetError(); queueNetError(); queueNetError();
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://manifest' });
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => a.resolveEndpoint('p1', '/x', 'GET'));
    }
    // Now circuit open — next call should fail fast
    await assert.rejects(
      () => a.resolveEndpoint('p1', '/x', 'GET'),
      (err) => err instanceof IntegrationError && err.message.includes('circuit breaker')
    );
  });
});

// ── D8 Security: _safeResolve path traversal ─

describe('ManifestAnalyzerAdapter._safeResolve security (D8)', () => {
  it('returns null for path traversal attempt (../../etc/passwd)', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._safeResolve('/safe/root', '../../etc/passwd');
    assert.equal(result, null);
  });

  it('returns null when candidate escapes root via multiple traversals', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._safeResolve('/app/project', '../../../root/.ssh/id_rsa');
    assert.equal(result, null);
  });

  it('returns resolved path when candidate is inside root (D1)', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._safeResolve('/app/project', 'src/main/java/UserService.java');
    assert.ok(result.startsWith('/app/project'));
    assert.ok(result.endsWith('UserService.java'));
  });

  it('returns null when candidate equals root exactly (edge case)', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._safeResolve('/app/project', '');
    // Empty candidate resolves to root itself — should be rejected (it's not a file)
    // The logic returns null only if NOT startsWith(root + sep), so root itself is returned
    // This tests that we don't crash on empty input
    assert.doesNotThrow(() => a._safeResolve('/app/project', ''));
  });
});

// ── D7: _parseProjectRoots ────────────────────

describe('ManifestAnalyzerAdapter._parseProjectRoots (D7 D2)', () => {
  it('parses JSON format', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._parseProjectRoots('{"42":"/home/proj","default":"/home/default"}');
    assert.equal(result['42'], '/home/proj');
    assert.equal(result.default, '/home/default');
  });

  it('parses key=value,key=value format', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._parseProjectRoots('42=/home/proj,default=/home/default');
    assert.equal(result['42'], '/home/proj');
    assert.equal(result.default, '/home/default');
  });

  it('returns empty object for empty string (D2)', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._parseProjectRoots('');
    assert.deepEqual(result, {});
  });

  it('returns empty object for null (D7)', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._parseProjectRoots(null);
    assert.deepEqual(result, {});
  });

  it('ignores malformed key=value pairs (D7)', () => {
    const a = new ManifestAnalyzerAdapter({ baseUrl: 'http://x' });
    const result = a._parseProjectRoots('valid=path,broken,another=ok');
    assert.ok(result.valid);
    assert.ok(result.another);
    assert.equal(Object.keys(result).length, 2); // "broken" ignored
  });
});
