// ─────────────────────────────────────────────
// Sentinel — Adapter: Manifest Analyzer
// Connects to Manifest/PermaCat API for code resolution
// Endpoint → Controller → Service → Repository → Entity
// ─────────────────────────────────────────────

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { AnalyzerPort } from '../../core/ports/analyzer.port.js';
import { IntegrationError } from '../../core/errors.js';
import { CircuitBreaker } from '../../core/infra/circuit-breaker.js';

export class ManifestAnalyzerAdapter extends AnalyzerPort {
  /**
   * @param {object} options
   * @param {string} options.baseUrl   — e.g. "https://probeserver-production.up.railway.app"
   * @param {string} [options.apiKey]
   * @param {number} [options.timeoutMs]
   * @param {string} [options.projectRoot]
   * @param {Record<string, string>} [options.projectRoots]
   */
  constructor({
    baseUrl,
    apiKey,
    timeoutMs = 10_000,
    projectRoot = process.env.SENTINEL_PROJECT_ROOT || process.env.PROJECT_ROOT || null,
    projectRoots = null,
  } = {}) {
    super();
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : '';
    this.apiKey = apiKey || null;
    this.timeoutMs = timeoutMs;
    this.projectRoot = projectRoot || null;
    this.projectRoots = projectRoots || this._parseProjectRoots(process.env.SENTINEL_PROJECT_ROOTS || '');

    // Circuit breaker: protects against Manifest API outages.
    // 4xx errors don't trip the breaker — those are our problem, not the API's.
    this._breaker = new CircuitBreaker({
      name: 'manifest-analyzer',
      failureThreshold: 3,
      windowMs: 60_000,
      recoveryMs: 30_000,
      timeoutMs: this.timeoutMs,
      isFailure: (err) => {
        if (err instanceof IntegrationError && err.context?.status >= 400 && err.context?.status < 500) {
          return false;
        }
        return true;
      },
    });
  }

  async resolveEndpoint(projectId, endpoint, method) {
    const entries = await this._fetchCatalogEntries(projectId);

    const match = entries.find(e =>
      e.endpoint === endpoint && e.httpMethod?.toUpperCase() === method?.toUpperCase()
    );

    if (!match) return null;

    return {
      endpoint: match.endpoint,
      httpMethod: match.httpMethod,
      controllerClass: match.controllerClass,
      controllerMethod: match.controllerMethod,
      serviceMethods: match.serviceMethods || [],
      repositoryMethods: match.repositoryMethods || [],
      entitiesTouched: match.entitiesTouched || [],
      fullCallChain: match.fullCallChain || [],
      persistenceOperations: match.persistenceOperations || [],
      sourceFiles: this._extractSourceFiles(match),
    };
  }

  async getSourceFile(projectId, filePath) {
    const rootDir = this._resolveProjectRoot(projectId);
    if (!rootDir || !filePath) return null;

    for (const candidate of this._getCandidatePaths(rootDir, filePath)) {
      try {
        return await readFile(candidate, 'utf8');
      } catch {
        // Try the next candidate path
      }
    }

    return null;
  }

  async listEndpoints(projectId) {
    const entries = await this._fetchCatalogEntries(projectId);
    return entries.map(e => ({
      endpoint: e.endpoint,
      method: e.httpMethod,
      controller: e.controllerClass,
    }));
  }

  async analyze(projectId) {
    const response = await this._protectedFetch(`/api/projects/${projectId}/analyze`, {
      method: 'POST',
    });
    return response;
  }

  isConfigured() {
    return !!this.baseUrl;
  }

  // ── Private ───────────────────────────────

  async _fetchCatalogEntries(projectId) {
    return this._protectedFetch(`/api/catalog-entries/${projectId}`);
  }

  /**
   * Route external HTTP calls through the circuit breaker.
   * When the circuit is OPEN, calls fail fast with IntegrationError
   * instead of waiting for timeouts against a dead service.
   */
  async _protectedFetch(pathName, options = {}) {
    try {
      return await this._breaker.fire(() => this._fetch(pathName, options));
    } catch (err) {
      if (err.isCircuitOpen) {
        throw new IntegrationError(
          'Manifest API circuit breaker is open — service unavailable',
          { url: `${this.baseUrl}${pathName}`, circuitState: 'open' },
        );
      }
      throw err;
    }
  }

  async _fetch(pathName, options = {}) {
    const url = `${this.baseUrl}${pathName}`;
    const headers = { 'Accept': 'application/json' };
    if (this.apiKey) headers['X-API-Key'] = this.apiKey;
    if (options.method === 'POST') headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: { ...headers, ...options.headers },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new IntegrationError(
          `Manifest API error: ${response.status} ${response.statusText}`,
          { url, status: response.status }
        );
      }

      return response.json();
    } catch (err) {
      if (err instanceof IntegrationError) throw err;
      if (err.name === 'AbortError') {
        throw new IntegrationError(`Manifest API timeout after ${this.timeoutMs}ms`, { url });
      }
      throw new IntegrationError(`Manifest API unreachable: ${err.message}`, { url });
    } finally {
      clearTimeout(timeout);
    }
  }

  _extractSourceFiles(entry) {
    const files = new Set();
    if (entry.controllerClass) {
      files.add(this._classToPath(entry.controllerClass));
    }
    if (entry.serviceMethods) {
      for (const sm of entry.serviceMethods) {
        if (sm.className) files.add(this._classToPath(sm.className));
      }
    }
    if (entry.repositoryMethods) {
      for (const rm of entry.repositoryMethods) {
        if (rm.className) files.add(this._classToPath(rm.className));
      }
    }
    return [...files];
  }

  _classToPath(className) {
    // Convert "easynup.services.web.contract.CreateContractWsV1" to file path
    return className.replace(/\./g, '/') + '.java';
  }

  _resolveProjectRoot(projectId) {
    const projectKey = String(projectId || '');
    const mappedRoot = this.projectRoots?.[projectKey]
      || this.projectRoots?.default
      || this.projectRoots?.['*'];

    if (mappedRoot) return mappedRoot;
    if (this.projectRoot) return this.projectRoot;

    const siblingCandidates = [
      path.resolve(process.cwd(), '..', projectKey),
      path.resolve(process.cwd(), '..', 'easynup'),
      path.resolve(process.cwd(), '..', 'EasyNuP'),
    ];

    return siblingCandidates.find((candidate) => existsSync(candidate)) || null;
  }

  _getCandidatePaths(rootDir, filePath) {
    const normalized = String(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
    const withoutPackagePrefix = normalized.replace(/^easynup\//, '');

    const candidates = [
      normalized,
      withoutPackagePrefix,
      path.join('src/main/java', normalized),
      path.join('src/main/java', withoutPackagePrefix),
      path.join('src', normalized),
      path.join('frontend', normalized),
    ];

    return [...new Set(
      candidates
        .map((candidate) => this._safeResolve(rootDir, candidate))
        .filter(Boolean)
    )];
  }

  _safeResolve(rootDir, candidate) {
    const resolvedRoot = path.resolve(rootDir);
    const resolvedPath = path.resolve(resolvedRoot, candidate);

    if (resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep)) {
      return resolvedPath;
    }

    return null;
  }

  getCircuitStatus() {
    return this._breaker.getStatus();
  }

  _parseProjectRoots(raw) {
    if (!raw) return {};

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Fallback to key=value,key=value format
    }

    const entries = raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => item.split('=').map((part) => part?.trim()));

    return Object.fromEntries(entries.filter(([key, value]) => key && value));
  }
}
