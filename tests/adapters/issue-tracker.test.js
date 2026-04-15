// ─────────────────────────────────────────────
// Tests — Issue Tracker Adapters
// Comprehensive tests for all 4 adapters:
//   GitHub, Linear, Jira, Noop
// Covers: createIssue, updateIssue, error paths,
//   timeout, _buildBody, label dedup, metadata
// 14-dimension: D1 D2 D6 D7 D8 D9 D13
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { IssueTrackerPort } from '../../src/core/ports/issue-tracker.port.js';
import { NoopIssueTrackerAdapter } from '../../src/adapters/issue-tracker/noop.adapter.js';
import { GitHubIssueAdapter } from '../../src/adapters/issue-tracker/github.adapter.js';
import { LinearIssueAdapter } from '../../src/adapters/issue-tracker/linear.adapter.js';
import { JiraIssueAdapter } from '../../src/adapters/issue-tracker/jira.adapter.js';
import { IntegrationError } from '../../src/core/errors.js';

// ── Fetch mock utilities ────────────────────

let _calls = [];
let _queue = [];
const _origFetch = globalThis.fetch;

function mockFetch() {
  _calls = [];
  _queue = [];
  globalThis.fetch = async (url, opts = {}) => {
    _calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body, signal: opts.signal });
    const resp = _queue.shift();
    if (!resp) return { ok: true, status: 200, json: async () => ({}) };
    if (resp.throw) throw resp.throw;
    return {
      ok: resp.ok ?? true,
      status: resp.status ?? 200,
      statusText: resp.statusText ?? 'OK',
      json: resp.json ?? (async () => ({})),
    };
  };
}

function restoreFetch() { globalThis.fetch = _origFetch; }

function queueOk(json) { _queue.push({ ok: true, status: 200, json: async () => json }); }
function queueError(status, json, statusText = 'Error') { _queue.push({ ok: false, status, statusText, json: async () => json }); }
function queueNetworkError(msg) { _queue.push({ throw: new TypeError(msg) }); }

// ── Port Contract ───────────────────────────

describe('IssueTrackerPort', () => {
  it('throws on unimplemented createIssue', async () => {
    const port = new IssueTrackerPort();
    await assert.rejects(() => port.createIssue({}), /not implemented/i);
  });

  it('throws on unimplemented updateIssue', async () => {
    const port = new IssueTrackerPort();
    await assert.rejects(() => port.updateIssue('123', {}), /not implemented/i);
  });

  it('isConfigured returns false by default', () => {
    assert.equal(new IssueTrackerPort().isConfigured(), false);
  });

  it('trackerName throws on base port', () => {
    assert.throws(() => new IssueTrackerPort().trackerName, /not implemented/i);
  });
});

// ── Noop Adapter ────────────────────────────

describe('NoopIssueTrackerAdapter', () => {
  let adapter;

  beforeEach(() => {
    adapter = new NoopIssueTrackerAdapter();
  });

  it('isConfigured returns false', () => {
    assert.equal(adapter.isConfigured(), false);
  });

  it('trackerName is "none"', () => {
    assert.equal(adapter.trackerName, 'none');
  });

  it('createIssue returns noop result', async () => {
    const result = await adapter.createIssue({ title: 'Test', description: 'Desc' });
    assert.equal(result.tracker, 'none');
    assert.equal(result.id, null);
    assert.equal(result.url, null);
  });

  it('updateIssue does not throw', async () => {
    await adapter.updateIssue('123', { comment: 'test' });
  });
});

// ── GitHub Adapter ──────────────────────────

describe('GitHubIssueAdapter', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  const makeGH = (overrides = {}) => new GitHubIssueAdapter({
    token: 'ghp_test', repo: 'org/repo', ...overrides,
  });

  // ── isConfigured ──

  it('isConfigured returns false without env vars', () => {
    const adapter = new GitHubIssueAdapter({ token: '', repo: '' });
    assert.equal(adapter.isConfigured(), false);
  });

  it('isConfigured returns true with token and repo', () => {
    assert.equal(makeGH().isConfigured(), true);
  });

  it('trackerName is "github"', () => {
    assert.equal(makeGH().trackerName, 'github');
  });

  // ── createIssue ──

  it('createIssue calls GitHub API with correct payload', async () => {
    queueOk({ number: 42, html_url: 'https://github.com/org/repo/issues/42' });
    const adapter = makeGH();
    const result = await adapter.createIssue({
      title: 'Bug: Login broken',
      description: 'Cannot log in',
      severity: 'high',
      type: 'bug',
      labels: ['extra'],
    });

    assert.equal(result.id, '42');
    assert.equal(result.url, 'https://github.com/org/repo/issues/42');
    assert.equal(result.tracker, 'github');

    assert.equal(_calls.length, 1);
    const [url, opts] = [_calls[0].url, _calls[0]];
    assert.ok(url.includes('repos/org/repo/issues'));
    assert.equal(opts.method, 'POST');
    assert.ok(opts.headers.Authorization.includes('ghp_test'));
    assert.equal(opts.headers['X-GitHub-Api-Version'], '2022-11-28');

    const body = JSON.parse(opts.body);
    assert.equal(body.title, 'Bug: Login broken');
    assert.ok(body.labels.includes('sentinel'));
    assert.ok(body.labels.includes('severity:high'));
    assert.ok(body.labels.includes('type:bug'));
    assert.ok(body.labels.includes('extra'));
  });

  it('createIssue deduplicates labels', async () => {
    queueOk({ number: 1, html_url: 'https://github.com/org/repo/issues/1' });
    const adapter = makeGH({ labels: ['sentinel'] });
    await adapter.createIssue({
      title: 't', description: 'd', severity: 'low', type: 'ux',
      labels: ['sentinel'], // duplicate of default
    });
    const body = JSON.parse(_calls[0].body);
    const sentinelCount = body.labels.filter(l => l === 'sentinel').length;
    assert.equal(sentinelCount, 1); // deduped via Set
  });

  it('createIssue includes metadata in body', async () => {
    queueOk({ number: 5, html_url: 'https://github.com/org/repo/issues/5' });
    const adapter = makeGH();
    await adapter.createIssue({
      title: 'With metadata', description: 'desc', severity: 'high', type: 'bug',
      metadata: {
        pageUrl: 'http://app.com/dashboard',
        findingId: 'f-123',
        diagnosis: {
          rootCause: 'Null pointer in handler',
          explanation: 'The handler fails when user is null',
          affectedFiles: ['src/handler.js', 'src/utils.js'],
        },
        correction: { summary: 'Add null check before accessing user.id' },
      },
    });
    const body = JSON.parse(_calls[0].body);
    assert.ok(body.body.includes('http://app.com/dashboard'));
    assert.ok(body.body.includes('f-123'));
    assert.ok(body.body.includes('Null pointer in handler'));
    assert.ok(body.body.includes('handler fails when user is null'));
    assert.ok(body.body.includes('src/handler.js'));
    assert.ok(body.body.includes('src/utils.js'));
    assert.ok(body.body.includes('Add null check'));
    assert.ok(body.body.includes('Sentinel'));
  });

  // ── updateIssue ──

  it('updateIssue adds comment', async () => {
    queueOk({ id: 1 });
    const adapter = makeGH();
    const result = await adapter.updateIssue('42', { comment: 'AI diagnosis attached' });

    assert.equal(result.id, '42');
    assert.ok(result.url.includes('/issues/42'));
    assert.equal(_calls.length, 1);
    assert.ok(_calls[0].url.includes('/issues/42/comments'));
    assert.equal(_calls[0].method, 'POST');
    const body = JSON.parse(_calls[0].body);
    assert.equal(body.body, 'AI diagnosis attached');
  });

  it('updateIssue closes issue', async () => {
    queueOk({ id: 1 });
    const adapter = makeGH();
    await adapter.updateIssue('42', { status: 'closed' });

    assert.equal(_calls.length, 1);
    assert.ok(_calls[0].url.endsWith('/repos/org/repo/issues/42'));
    assert.equal(_calls[0].method, 'PATCH');
    const body = JSON.parse(_calls[0].body);
    assert.equal(body.state, 'closed');
  });

  it('updateIssue reopens issue', async () => {
    queueOk({});
    const adapter = makeGH();
    await adapter.updateIssue('42', { status: 'open' });
    const body = JSON.parse(_calls[0].body);
    assert.equal(body.state, 'open');
  });

  it('updateIssue updates labels', async () => {
    queueOk({});
    const adapter = makeGH();
    await adapter.updateIssue('42', { labels: ['verified', 'fixed'] });
    const body = JSON.parse(_calls[0].body);
    assert.deepEqual(body.labels, ['verified', 'fixed']);
  });

  it('updateIssue comment + close in parallel', async () => {
    queueOk({ id: 1 }); // comment
    queueOk({ id: 1 }); // patch
    const adapter = makeGH();
    await adapter.updateIssue('42', { comment: 'Fixed.', status: 'closed' });
    assert.equal(_calls.length, 2);
  });

  it('updateIssue no-ops when no comment/status/labels', async () => {
    const adapter = makeGH();
    const result = await adapter.updateIssue('42', {});
    assert.equal(result.id, '42');
    assert.equal(_calls.length, 0);
  });

  // ── Error paths ──

  it('createIssue throws IntegrationError on API error', async () => {
    queueError(422, { message: 'Validation Failed' });
    const adapter = makeGH();
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('422'));
        assert.ok(err.message.includes('Validation Failed'));
        return true;
      },
    );
  });

  it('createIssue throws IntegrationError on network error', async () => {
    queueNetworkError('fetch failed');
    const adapter = makeGH();
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('unreachable'));
        return true;
      },
    );
  });

  it('createIssue throws IntegrationError on timeout', async () => {
    // Override fetch to simulate AbortError
    globalThis.fetch = async () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      throw err;
    };
    const adapter = makeGH({ timeoutMs: 1 });
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('timeout'));
        return true;
      },
    );
  });

  it('_fetch falls back to statusText when JSON parse fails', async () => {
    _queue.push({
      ok: false, status: 500, statusText: 'Internal Server Error',
      json: async () => { throw new Error('not json'); },
    });
    const adapter = makeGH();
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('500'));
        return true;
      },
    );
  });
});

// ── Linear Adapter ──────────────────────────

describe('LinearIssueAdapter', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  const makeLin = (overrides = {}) => new LinearIssueAdapter({
    apiKey: 'lin_test', teamId: 'TEAM-1', ...overrides,
  });

  const linearIssueResponse = (id = 'TEAM-42', url = 'https://linear.app/team/issue/TEAM-42') => ({
    data: { issueCreate: { success: true, issue: { id: 'lin-uuid', identifier: id, url } } },
  });

  // ── isConfigured ──

  it('isConfigured returns false without api key', () => {
    assert.equal(new LinearIssueAdapter({ apiKey: '', teamId: '' }).isConfigured(), false);
  });

  it('isConfigured returns true with api key and team id', () => {
    assert.equal(makeLin().isConfigured(), true);
  });

  it('trackerName is "linear"', () => {
    assert.equal(makeLin().trackerName, 'linear');
  });

  // ── createIssue ──

  it('createIssue calls Linear GraphQL with correct priority', async () => {
    queueOk(linearIssueResponse());
    const adapter = makeLin();
    const result = await adapter.createIssue({
      title: 'Critical bug', description: 'System down', severity: 'critical', type: 'bug',
    });

    assert.equal(result.id, 'TEAM-42');
    assert.ok(result.url.includes('linear.app'));
    assert.equal(result.tracker, 'linear');

    assert.equal(_calls.length, 1);
    const body = JSON.parse(_calls[0].body);
    assert.ok(body.query.includes('issueCreate'));
    assert.equal(body.variables.input.priority, 1); // critical → 1
    assert.equal(body.variables.input.teamId, 'TEAM-1');
  });

  it('createIssue maps severity to Linear priority', async () => {
    for (const [severity, expected] of [['high', 2], ['medium', 3], ['low', 4]]) {
      _calls = [];
      queueOk(linearIssueResponse());
      const adapter = makeLin();
      await adapter.createIssue({ title: 't', description: 'd', severity, type: 'bug' });
      const body = JSON.parse(_calls[0].body);
      assert.equal(body.variables.input.priority, expected, `${severity} → ${expected}`);
    }
  });

  it('createIssue defaults unmapped severity to priority 3', async () => {
    queueOk(linearIssueResponse());
    const adapter = makeLin();
    await adapter.createIssue({ title: 't', description: 'd', severity: 'unknown', type: 'bug' });
    const body = JSON.parse(_calls[0].body);
    assert.equal(body.variables.input.priority, 3);
  });

  it('createIssue resolves label IDs when labels provided', async () => {
    // First call: label lookup; second call: createIssue
    queueOk({ data: { issueLabels: { nodes: [
      { id: 'lbl-1', name: 'Bug' },
      { id: 'lbl-2', name: 'Urgent' },
    ] } } });
    queueOk(linearIssueResponse());

    const adapter = makeLin();
    await adapter.createIssue({
      title: 't', description: 'd', severity: 'high', type: 'bug',
      labels: ['bug', 'nonexistent'],
    });

    assert.equal(_calls.length, 2);
    // Second call is the mutation
    const mutationBody = JSON.parse(_calls[1].body);
    assert.deepEqual(mutationBody.variables.input.labelIds, ['lbl-1']); // only 'bug' matched
  });

  it('createIssue skips labelIds when no labels', async () => {
    queueOk(linearIssueResponse());
    const adapter = makeLin();
    await adapter.createIssue({ title: 't', description: 'd', severity: 'high', type: 'bug' });
    const body = JSON.parse(_calls[0].body);
    assert.equal(body.variables.input.labelIds, undefined);
  });

  it('createIssue throws when Linear returns no issue', async () => {
    queueOk({ data: { issueCreate: { success: false, issue: null } } });
    const adapter = makeLin();
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('failed to create'));
        return true;
      },
    );
  });

  it('createIssue includes diagnosis metadata in body', async () => {
    queueOk(linearIssueResponse());
    const adapter = makeLin();
    await adapter.createIssue({
      title: 'meta', description: 'desc', severity: 'high', type: 'bug',
      metadata: {
        pageUrl: 'http://app/page',
        findingId: 'f-99',
        diagnosis: { rootCause: 'Race condition', explanation: 'Two writes conflict' },
        correction: { summary: 'Use mutex' },
      },
    });
    const body = JSON.parse(_calls[0].body);
    const desc = body.variables.input.description;
    assert.ok(desc.includes('http://app/page'));
    assert.ok(desc.includes('f-99'));
    assert.ok(desc.includes('Race condition'));
    assert.ok(desc.includes('Use mutex'));
  });

  // ── updateIssue ──

  it('updateIssue adds comment', async () => {
    queueOk({ data: { commentCreate: { success: true } } });
    const adapter = makeLin();
    const result = await adapter.updateIssue('TEAM-42', { comment: 'New diagnosis' });

    assert.equal(result.id, 'TEAM-42');
    assert.ok(result.url.includes('TEAM-42'));
    assert.equal(_calls.length, 1);
    const body = JSON.parse(_calls[0].body);
    assert.ok(body.query.includes('commentCreate'));
    assert.equal(body.variables.input.body, 'New diagnosis');
  });

  it('updateIssue closes issue via workflow state', async () => {
    // First call: getDoneStateId; second: issueUpdate
    queueOk({ data: { workflowStates: { nodes: [{ id: 'state-done', name: 'Done' }] } } });
    queueOk({ data: { issueUpdate: { success: true, issue: { url: 'https://linear.app/...' } } } });
    const adapter = makeLin();
    await adapter.updateIssue('TEAM-42', { status: 'closed' });

    assert.equal(_calls.length, 2);
    const mutBody = JSON.parse(_calls[1].body);
    assert.ok(mutBody.query.includes('issueUpdate'));
    assert.equal(mutBody.variables.input.stateId, 'state-done');
  });

  it('updateIssue comment + close in parallel', async () => {
    queueOk({ data: { commentCreate: { success: true } } });
    queueOk({ data: { workflowStates: { nodes: [{ id: 'done-id', name: 'Done' }] } } });
    queueOk({ data: { issueUpdate: { success: true } } });
    const adapter = makeLin();
    await adapter.updateIssue('TEAM-42', { comment: 'Closing', status: 'closed' });
    assert.ok(_calls.length >= 2);
  });

  // ── Error paths ──

  it('throws IntegrationError on HTTP error', async () => {
    queueError(401, {}, 'Unauthorized');
    const adapter = makeLin();
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('401'));
        return true;
      },
    );
  });

  it('throws IntegrationError on GraphQL errors', async () => {
    queueOk({ errors: [{ message: 'Field "badField" not found' }] });
    const adapter = makeLin();
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('badField'));
        return true;
      },
    );
  });

  it('throws IntegrationError on network failure', async () => {
    queueNetworkError('ECONNREFUSED');
    const adapter = makeLin();
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('unreachable'));
        return true;
      },
    );
  });

  it('throws IntegrationError on timeout', async () => {
    globalThis.fetch = async () => {
      const err = new DOMException('aborted', 'AbortError');
      throw err;
    };
    const adapter = makeLin({ timeoutMs: 1 });
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('timeout'));
        return true;
      },
    );
  });
});

// ── Jira Adapter ────────────────────────────

describe('JiraIssueAdapter', () => {
  beforeEach(mockFetch);
  afterEach(restoreFetch);

  const makeJira = (overrides = {}) => new JiraIssueAdapter({
    baseUrl: 'https://test.atlassian.net',
    email: 'test@test.com',
    token: 'jira-token',
    projectKey: 'TEST',
    ...overrides,
  });

  // ── isConfigured ──

  it('isConfigured returns false without config', () => {
    assert.equal(new JiraIssueAdapter({ baseUrl: '', email: '', token: '', projectKey: '' }).isConfigured(), false);
  });

  it('isConfigured returns true with all config', () => {
    assert.equal(makeJira().isConfigured(), true);
  });

  it('trackerName is "jira"', () => {
    assert.equal(makeJira().trackerName, 'jira');
  });

  it('strips trailing slash from baseUrl', () => {
    const adapter = makeJira({ baseUrl: 'https://test.atlassian.net/' });
    assert.equal(adapter.baseUrl, 'https://test.atlassian.net');
  });

  // ── createIssue ──

  it('createIssue sends ADF document format', async () => {
    queueOk({ id: '10001', key: 'TEST-99' });
    const adapter = makeJira();
    const result = await adapter.createIssue({
      title: 'Bug report', description: 'Detailed description',
      severity: 'medium', type: 'bug',
    });

    assert.equal(result.id, 'TEST-99');
    assert.ok(result.url.includes('atlassian.net/browse/TEST-99'));
    assert.equal(result.tracker, 'jira');

    const body = JSON.parse(_calls[0].body);
    assert.equal(body.fields.project.key, 'TEST');
    assert.equal(body.fields.summary, 'Bug report');
    assert.equal(body.fields.description.type, 'doc');
    assert.equal(body.fields.issuetype.name, 'Bug');
    assert.equal(body.fields.priority.name, 'Medium');
  });

  it('createIssue maps severity to Jira priority', async () => {
    for (const [severity, expected] of [['critical', 'Highest'], ['high', 'High'], ['low', 'Low']]) {
      _calls = [];
      queueOk({ key: 'TEST-1' });
      await makeJira().createIssue({ title: 't', description: 'd', severity, type: 'bug' });
      const body = JSON.parse(_calls[0].body);
      assert.equal(body.fields.priority.name, expected, `${severity} → ${expected}`);
    }
  });

  it('createIssue defaults unmapped severity to Medium', async () => {
    queueOk({ key: 'TEST-1' });
    await makeJira().createIssue({ title: 't', description: 'd', severity: 'unknown', type: 'bug' });
    const body = JSON.parse(_calls[0].body);
    assert.equal(body.fields.priority.name, 'Medium');
  });

  it('createIssue includes sentinel + type labels', async () => {
    queueOk({ key: 'TEST-1' });
    await makeJira().createIssue({
      title: 't', description: 'd', severity: 'low', type: 'ux',
      labels: ['frontend'],
    });
    const body = JSON.parse(_calls[0].body);
    assert.ok(body.fields.labels.includes('sentinel'));
    assert.ok(body.fields.labels.includes('sentinel-ux'));
    assert.ok(body.fields.labels.includes('frontend'));
  });

  it('createIssue includes metadata in ADF body', async () => {
    queueOk({ key: 'TEST-7' });
    await makeJira().createIssue({
      title: 'meta', description: 'desc', severity: 'high', type: 'bug',
      metadata: {
        pageUrl: 'http://app/settings',
        diagnosis: {
          rootCause: 'Missing index on users table',
          explanation: 'Full table scan causing 10s load',
        },
        correction: { summary: 'Add composite index' },
      },
    });
    const body = JSON.parse(_calls[0].body);
    const adf = body.fields.description;
    const allText = JSON.stringify(adf);
    assert.ok(allText.includes('http://app/settings'));
    assert.ok(allText.includes('Missing index'));
    assert.ok(allText.includes('Full table scan'));
    assert.ok(allText.includes('Add composite index'));
  });

  it('createIssue uses Basic auth header', async () => {
    queueOk({ key: 'TEST-1' });
    await makeJira().createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' });
    const auth = _calls[0].headers.Authorization;
    assert.ok(auth.startsWith('Basic '));
    const decoded = Buffer.from(auth.replace('Basic ', ''), 'base64').toString();
    assert.equal(decoded, 'test@test.com:jira-token');
  });

  // ── updateIssue ──

  it('updateIssue adds comment in ADF format', async () => {
    queueOk({ id: '1001' });
    const adapter = makeJira();
    const result = await adapter.updateIssue('TEST-99', { comment: 'Diagnosis ready' });

    assert.equal(result.id, 'TEST-99');
    assert.ok(result.url.includes('/browse/TEST-99'));
    assert.equal(_calls.length, 1);
    assert.ok(_calls[0].url.includes('/issue/TEST-99/comment'));
    assert.equal(_calls[0].method, 'POST');
    const body = JSON.parse(_calls[0].body);
    assert.equal(body.body.type, 'doc');
    const text = body.body.content[0].content[0].text;
    assert.equal(text, 'Diagnosis ready');
  });

  it('updateIssue closes issue via transition', async () => {
    // First call: get transitions; second: POST transition
    queueOk({ transitions: [
      { id: '31', name: 'In Progress' },
      { id: '41', name: 'Done' },
      { id: '51', name: 'Rejected' },
    ] });
    queueOk({});
    const adapter = makeJira();
    await adapter.updateIssue('TEST-99', { status: 'closed' });

    assert.equal(_calls.length, 2);
    // First: GET transitions
    assert.ok(_calls[0].url.includes('/transitions'));
    // Second: POST transition with Done id
    const body = JSON.parse(_calls[1].body);
    assert.equal(body.transition.id, '41');
  });

  it('updateIssue finds "resolved" transition', async () => {
    queueOk({ transitions: [{ id: '61', name: 'Resolved' }] });
    queueOk({});
    await makeJira().updateIssue('TEST-1', { status: 'closed' });
    const body = JSON.parse(_calls[1].body);
    assert.equal(body.transition.id, '61');
  });

  it('updateIssue finds "closed" transition', async () => {
    queueOk({ transitions: [{ id: '71', name: 'Closed' }] });
    queueOk({});
    await makeJira().updateIssue('TEST-1', { status: 'closed' });
    const body = JSON.parse(_calls[1].body);
    assert.equal(body.transition.id, '71');
  });

  it('updateIssue skips transition when no done/resolved/closed found', async () => {
    queueOk({ transitions: [{ id: '21', name: 'Backlog' }, { id: '31', name: 'In Progress' }] });
    await makeJira().updateIssue('TEST-99', { status: 'closed' });
    // Only the GET transitions call — no POST transition
    assert.equal(_calls.length, 1);
  });

  it('updateIssue comment + close in parallel', async () => {
    queueOk({ id: 1 }); // comment
    queueOk({ transitions: [{ id: '41', name: 'Done' }] }); // get transitions
    queueOk({}); // post transition
    await makeJira().updateIssue('TEST-99', { comment: 'Closing', status: 'closed' });
    assert.ok(_calls.length >= 2);
  });

  // ── Error paths ──

  it('throws IntegrationError on API error', async () => {
    queueError(400, { errorMessages: ['Project not found'] });
    await assert.rejects(
      () => makeJira().createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('400'));
        assert.ok(err.message.includes('Project not found'));
        return true;
      },
    );
  });

  it('throws IntegrationError on network failure', async () => {
    queueNetworkError('ENOTFOUND');
    await assert.rejects(
      () => makeJira().createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('unreachable'));
        return true;
      },
    );
  });

  it('throws IntegrationError on timeout', async () => {
    globalThis.fetch = async () => {
      const err = new DOMException('aborted', 'AbortError');
      throw err;
    };
    const adapter = makeJira({ timeoutMs: 1 });
    await assert.rejects(
      () => adapter.createIssue({ title: 't', description: 'd', severity: 'low', type: 'bug' }),
      (err) => {
        assert.ok(err instanceof IntegrationError);
        assert.ok(err.message.includes('timeout'));
        return true;
      },
    );
  });

  it('_fetch handles 204 No Content responses', async () => {
    _queue.push({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    // 204 should return {} without calling json()
    // Test indirectly: updateIssue transition POST returns 204
    // We test _fetch directly via a createIssue that gets 204 back — but createIssue
    // uses the response, so let's test via updateIssue with comment
    // Actually _fetch checks status === 204 and returns {}
    // Let's just verify it doesn't throw
    const adapter = makeJira();
    // Trigger a fetch that returns 204 via transition post
    queueOk({ transitions: [{ id: '41', name: 'Done' }] });
    _queue.push({ ok: true, status: 204, statusText: 'No Content', json: async () => { throw new Error('no body'); } });
    await adapter.updateIssue('TEST-1', { status: 'closed' });
    assert.ok(true); // no throw
  });
});
