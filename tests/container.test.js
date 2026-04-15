// ─────────────────────────────────────────────
// Tests — Container DI wiring
// D1 D7 D8 D9 D13 (singleton)
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getContainer, resetContainer } from '../../src/container.js';
import { MemoryStorageAdapter } from '../../src/adapters/storage/memory.adapter.js';
import { ManifestAnalyzerAdapter } from '../../src/adapters/analyzer/manifest.adapter.js';
import { NoopAnalyzerAdapter } from '../../src/adapters/analyzer/noop.adapter.js';
import { ClaudeAIAdapter } from '../../src/adapters/ai/claude.adapter.js';
import { WebhookNotificationAdapter } from '../../src/adapters/notification/webhook.adapter.js';
import { NoopNotificationAdapter } from '../../src/adapters/notification/noop.adapter.js';
import { GitHubIssueAdapter } from '../../src/adapters/issue-tracker/github.adapter.js';
import { LinearIssueAdapter } from '../../src/adapters/issue-tracker/linear.adapter.js';
import { JiraIssueAdapter } from '../../src/adapters/issue-tracker/jira.adapter.js';
import { NoopIssueTrackerAdapter } from '../../src/adapters/issue-tracker/noop.adapter.js';

// ── Env helpers ───────────────────────────────

const SENTINEL_VARS = [
  'SENTINEL_MEMORY_STORAGE', 'DATABASE_URL', 'MANIFEST_URL', 'MANIFEST_API_KEY',
  'ANTHROPIC_API_KEY', 'WEBHOOK_URL', 'WEBHOOK_SECRET',
  'SENTINEL_GITHUB_TOKEN', 'SENTINEL_GITHUB_REPO',
  'SENTINEL_LINEAR_API_KEY', 'SENTINEL_LINEAR_TEAM_ID',
  'SENTINEL_JIRA_URL', 'SENTINEL_JIRA_TOKEN',
  'DEBUG_PROBE_URL', 'SENTINEL_TRACE',
];

let savedEnvs = {};
function saveEnvs() {
  savedEnvs = {};
  for (const k of SENTINEL_VARS) {
    savedEnvs[k] = process.env[k];
    delete process.env[k];
  }
}
function restoreEnvs() {
  for (const k of SENTINEL_VARS) {
    if (savedEnvs[k] !== undefined) process.env[k] = savedEnvs[k];
    else delete process.env[k];
  }
}

beforeEach(() => { saveEnvs(); resetContainer(); process.env.SENTINEL_MEMORY_STORAGE = 'true'; });
afterEach(() => { restoreEnvs(); resetContainer(); });

// ── D7 D1: Storage selection ─────────────────

describe('Container storage adapter selection (D7 D1)', () => {
  it('uses MemoryStorageAdapter when SENTINEL_MEMORY_STORAGE=true (D1)', async () => {
    const c = await getContainer();
    assert.ok(c.adapters.storage instanceof MemoryStorageAdapter);
  });

  it('uses MemoryStorageAdapter when no DATABASE_URL and not SENTINEL_MEMORY_STORAGE (D7)', async () => {
    delete process.env.SENTINEL_MEMORY_STORAGE;
    // No DATABASE_URL either — falls back to memory
    const c = await getContainer();
    assert.ok(c.adapters.storage instanceof MemoryStorageAdapter);
  });
});

// ── D8: Analyzer selection ────────────────────

describe('Container analyzer adapter selection (D8)', () => {
  it('uses NoopAnalyzerAdapter when MANIFEST_URL not set (D7)', async () => {
    const c = await getContainer();
    assert.ok(c.adapters.analyzer instanceof NoopAnalyzerAdapter);
  });

  it('uses ManifestAnalyzerAdapter when MANIFEST_URL is set (D1)', async () => {
    process.env.MANIFEST_URL = 'https://manifest.example.com';
    const c = await getContainer();
    assert.ok(c.adapters.analyzer instanceof ManifestAnalyzerAdapter);
    assert.equal(c.adapters.analyzer.baseUrl, 'https://manifest.example.com');
  });

  it('passes MANIFEST_API_KEY to ManifestAnalyzerAdapter (D9)', async () => {
    process.env.MANIFEST_URL = 'https://manifest.example.com';
    process.env.MANIFEST_API_KEY = 'proj-api-key';
    const c = await getContainer();
    assert.equal(c.adapters.analyzer.apiKey, 'proj-api-key');
  });
});

// ── D8: AI selection ──────────────────────────

describe('Container AI adapter selection (D8)', () => {
  it('returns noop-like adapter without AI key (D7)', async () => {
    const c = await getContainer();
    // Without ANTHROPIC_API_KEY, buildAI returns a plain object { isConfigured: () => false }
    assert.equal(c.adapters.ai.isConfigured(), false);
  });

  it('uses ClaudeAIAdapter when ANTHROPIC_API_KEY is set (D1)', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const c = await getContainer();
    assert.ok(c.adapters.ai instanceof ClaudeAIAdapter);
    assert.equal(c.adapters.ai.isConfigured(), true);
  });
});

// ── D8: Notification selection ────────────────

describe('Container notification adapter selection (D8)', () => {
  it('uses NoopNotificationAdapter when WEBHOOK_URL not set (D7)', async () => {
    const c = await getContainer();
    assert.ok(c.adapters.notification instanceof NoopNotificationAdapter);
  });

  it('uses WebhookNotificationAdapter when WEBHOOK_URL is set (D1)', async () => {
    process.env.WEBHOOK_URL = 'https://hooks.example.com/events';
    const c = await getContainer();
    assert.ok(c.adapters.notification instanceof WebhookNotificationAdapter);
    assert.equal(c.adapters.notification.url, 'https://hooks.example.com/events');
  });

  it('passes WEBHOOK_SECRET to WebhookNotificationAdapter (D9)', async () => {
    process.env.WEBHOOK_URL = 'https://hooks.example.com/events';
    process.env.WEBHOOK_SECRET = 'hmac-secret-xyz';
    const c = await getContainer();
    assert.equal(c.adapters.notification.secret, 'hmac-secret-xyz');
  });
});

// ── D8: Issue tracker selection (priority: GitHub > Linear > Jira) ──

describe('Container issue tracker adapter selection (D8 priority)', () => {
  it('uses NoopIssueTrackerAdapter when no tracker configured (D7)', async () => {
    const c = await getContainer();
    assert.ok(c.adapters.issueTracker instanceof NoopIssueTrackerAdapter);
  });

  it('uses GitHubIssueAdapter when SENTINEL_GITHUB_TOKEN+REPO set (D1)', async () => {
    process.env.SENTINEL_GITHUB_TOKEN = 'ghp_test';
    process.env.SENTINEL_GITHUB_REPO = 'owner/repo';
    const c = await getContainer();
    assert.ok(c.adapters.issueTracker instanceof GitHubIssueAdapter);
  });

  it('uses LinearIssueAdapter when Linear keys set (D1)', async () => {
    process.env.SENTINEL_LINEAR_API_KEY = 'lin_api_key';
    process.env.SENTINEL_LINEAR_TEAM_ID = 'team-abc';
    const c = await getContainer();
    assert.ok(c.adapters.issueTracker instanceof LinearIssueAdapter);
  });

  it('uses JiraIssueAdapter when Jira keys set (D1)', async () => {
    process.env.SENTINEL_JIRA_URL = 'https://acme.atlassian.net';
    process.env.SENTINEL_JIRA_TOKEN = 'jira-token';
    const c = await getContainer();
    assert.ok(c.adapters.issueTracker instanceof JiraIssueAdapter);
  });

  // D8: Priority — GitHub wins over Linear
  it('GitHub takes priority over Linear (D8)', async () => {
    process.env.SENTINEL_GITHUB_TOKEN = 'ghp_test';
    process.env.SENTINEL_GITHUB_REPO = 'owner/repo';
    process.env.SENTINEL_LINEAR_API_KEY = 'lin_api_key';
    process.env.SENTINEL_LINEAR_TEAM_ID = 'team-abc';
    const c = await getContainer();
    assert.ok(c.adapters.issueTracker instanceof GitHubIssueAdapter);
  });

  // D8: Priority — GitHub wins over Jira
  it('GitHub takes priority over Jira (D8)', async () => {
    process.env.SENTINEL_GITHUB_TOKEN = 'ghp_test';
    process.env.SENTINEL_GITHUB_REPO = 'owner/repo';
    process.env.SENTINEL_JIRA_URL = 'https://acme.atlassian.net';
    process.env.SENTINEL_JIRA_TOKEN = 'jira-token';
    const c = await getContainer();
    assert.ok(c.adapters.issueTracker instanceof GitHubIssueAdapter);
  });

  // D8: Priority — Linear wins over Jira
  it('Linear takes priority over Jira (D8)', async () => {
    process.env.SENTINEL_LINEAR_API_KEY = 'lin_api_key';
    process.env.SENTINEL_LINEAR_TEAM_ID = 'team-abc';
    process.env.SENTINEL_JIRA_URL = 'https://acme.atlassian.net';
    process.env.SENTINEL_JIRA_TOKEN = 'jira-token';
    const c = await getContainer();
    assert.ok(c.adapters.issueTracker instanceof LinearIssueAdapter);
  });
});

// ── D13: Singleton pattern ────────────────────

describe('Container singleton (D13)', () => {
  it('second call returns same frozen object', async () => {
    const c1 = await getContainer();
    const c2 = await getContainer();
    assert.equal(c1, c2);
  });

  it('container is frozen — adapter replacement throws (D13)', async () => {
    const c = await getContainer();
    assert.throws(() => { c.adapters.storage = null; }, TypeError);
  });

  it('resetContainer() clears singleton — next call builds fresh (D13)', async () => {
    const c1 = await getContainer();
    resetContainer();
    process.env.MANIFEST_URL = 'https://manifest.example.com';
    const c2 = await getContainer();
    assert.notEqual(c1, c2);
    assert.ok(c2.adapters.analyzer instanceof ManifestAnalyzerAdapter);
  });
});

// ── D9: Services are wired to correct adapters ─

describe('Container service wiring (D9)', () => {
  it('exposes sessions, findings, diagnosis, correction, integration services', async () => {
    const c = await getContainer();
    assert.ok(c.services.sessions);
    assert.ok(c.services.findings);
    assert.ok(c.services.diagnosis);
    assert.ok(c.services.correction);
    assert.ok(c.services.integration);
  });
});
