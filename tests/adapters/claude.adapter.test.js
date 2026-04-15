// ─────────────────────────────────────────────
// Tests — ClaudeAIAdapter
// D1 D2 D6 D7 D8 D9
// ─────────────────────────────────────────────

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeAIAdapter } from '../../src/adapters/ai/claude.adapter.js';
import { IntegrationError } from '../../src/core/errors.js';

// ── Mock client ───────────────────────────────

function makeMockClient(responseText = '{"rootCause":"null pointer","confidence":"high"}') {
  const calls = [];
  return {
    messages: {
      create: async (params) => {
        calls.push(params);
        return { content: [{ text: responseText }] };
      },
    },
    _calls: calls,
  };
}

function makeAdapter(apiKey = 'test-key-abc') {
  const adapter = new ClaudeAIAdapter({ apiKey });
  adapter._client = makeMockClient();
  return adapter;
}

// ── D8: isConfigured ─────────────────────────

describe('ClaudeAIAdapter.isConfigured (D8)', () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv; else delete process.env.ANTHROPIC_API_KEY; });

  it('returns true when apiKey passed to constructor', () => {
    const a = new ClaudeAIAdapter({ apiKey: 'my-key' });
    assert.equal(a.isConfigured(), true);
  });

  it('returns true when ANTHROPIC_API_KEY env var is set', () => {
    process.env.ANTHROPIC_API_KEY = 'env-key';
    const a = new ClaudeAIAdapter();
    assert.equal(a.isConfigured(), true);
  });

  it('returns false when neither constructor param nor env var set', () => {
    const a = new ClaudeAIAdapter();
    assert.equal(a.isConfigured(), false);
  });
});

// ── D6: _getClient throws when not configured ─

describe('ClaudeAIAdapter._getClient (D6)', () => {
  let savedEnv;
  beforeEach(() => { savedEnv = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY; });
  afterEach(() => { if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv; else delete process.env.ANTHROPIC_API_KEY; });

  it('throws IntegrationError when not configured', async () => {
    const a = new ClaudeAIAdapter();
    await assert.rejects(() => a._getClient(), IntegrationError);
  });

  it('returns injected client without Anthropic SDK import (D9 testability)', async () => {
    const a = new ClaudeAIAdapter({ apiKey: 'key' });
    const mock = makeMockClient();
    a._client = mock;
    const client = await a._getClient();
    assert.equal(client, mock);
  });
});

// ── D7: _parseJSON ────────────────────────────

describe('ClaudeAIAdapter._parseJSON (D7 D2)', () => {
  it('parses plain JSON string', () => {
    const a = makeAdapter();
    const result = a._parseJSON('{"rootCause":"null pointer"}');
    assert.equal(result.rootCause, 'null pointer');
  });

  it('extracts JSON from ```json code block', () => {
    const a = makeAdapter();
    const result = a._parseJSON('```json\n{"confidence":"high"}\n```');
    assert.equal(result.confidence, 'high');
  });

  it('extracts JSON from plain ``` code block', () => {
    const a = makeAdapter();
    const result = a._parseJSON('```\n{"confidence":"low"}\n```');
    assert.equal(result.confidence, 'low');
  });

  it('returns { raw, parseError: true } on invalid JSON (D6)', () => {
    const a = makeAdapter();
    const result = a._parseJSON('not valid json at all');
    assert.equal(result.parseError, true);
    assert.ok(result.raw);
  });

  it('handles empty string gracefully (D2)', () => {
    const a = makeAdapter();
    const result = a._parseJSON('');
    assert.equal(result.parseError, true);
  });
});

// ── D1 D9: diagnose ───────────────────────────

describe('ClaudeAIAdapter.diagnose (D1 D9)', () => {
  it('returns parsed diagnosis object', async () => {
    const a = makeAdapter();
    a._client = makeMockClient('{"rootCause":"null pointer","confidence":"high","category":"logic"}');
    const result = await a.diagnose({ finding: { id: 'f1', description: 'button broken' } });
    assert.equal(result.rootCause, 'null pointer');
    assert.equal(result.confidence, 'high');
  });

  it('calls model with DIAGNOSIS_SYSTEM prompt (D9)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.diagnose({ finding: { id: 'f1', description: 'test' } });
    const call = mock._calls[0];
    assert.ok(call.system.includes('ROOT CAUSE'));
    assert.equal(call.messages[0].role, 'user');
  });

  it('uses configured model (D9)', async () => {
    const a = new ClaudeAIAdapter({ apiKey: 'key', model: 'claude-custom-model' });
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.diagnose({ finding: { id: 'f1' } });
    assert.equal(mock._calls[0].model, 'claude-custom-model');
  });

  it('sets max_tokens to 4096 (D9)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.diagnose({ finding: { id: 'f1' } });
    assert.equal(mock._calls[0].max_tokens, 4096);
  });

  it('includes traces section when provided (D8)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.diagnose({
      finding: { id: 'f1', description: 'err' },
      traces: [{ method: 'GET', path: '/api/x', duration: 123 }],
    });
    const userMsg = mock._calls[0].messages[0].content;
    assert.ok(userMsg.includes('Backend Traces'));
  });

  it('includes codeChain section when provided (D8)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.diagnose({
      finding: { id: 'f1' },
      codeChain: { controller: 'UserController', method: 'getUser' },
    });
    const userMsg = mock._calls[0].messages[0].content;
    assert.ok(userMsg.includes('Code Chain'));
  });

  it('includes sourceFiles section when provided (D8)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.diagnose({
      finding: { id: 'f1' },
      sourceFiles: { 'src/User.java': 'public class User {}' },
    });
    const userMsg = mock._calls[0].messages[0].content;
    assert.ok(userMsg.includes('Source Code'));
    assert.ok(userMsg.includes('User.java'));
  });

  it('omits optional sections when not provided (D7)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.diagnose({ finding: { id: 'f1' } });
    const userMsg = mock._calls[0].messages[0].content;
    assert.ok(!userMsg.includes('Backend Traces'));
    assert.ok(!userMsg.includes('Code Chain'));
    assert.ok(!userMsg.includes('Source Code'));
  });
});

// ── D1 D9: generateCorrection ─────────────────

describe('ClaudeAIAdapter.generateCorrection (D1 D9)', () => {
  it('returns parsed correction object', async () => {
    const a = makeAdapter();
    a._client = makeMockClient('{"files":[],"summary":"no change needed"}');
    const result = await a.generateCorrection({ finding: { id: 'f1' }, diagnosis: { rootCause: 'null ptr' } });
    assert.deepEqual(result.files, []);
    assert.equal(result.summary, 'no change needed');
  });

  it('calls model with CORRECTION_SYSTEM prompt (D9)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.generateCorrection({ finding: { id: 'f1' }, diagnosis: {} });
    assert.ok(mock._calls[0].system.includes('code correction'));
  });

  it('uses max_tokens 8192 (D9)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.generateCorrection({ finding: { id: 'f1' }, diagnosis: {} });
    assert.equal(mock._calls[0].max_tokens, 8192);
  });
});

// ── D1 D9: clarify ────────────────────────────

describe('ClaudeAIAdapter.clarify (D1 D9)', () => {
  it('returns plain string answer', async () => {
    const a = makeAdapter();
    a._client = makeMockClient('The error happens on line 42.');
    const result = await a.clarify({ finding: { id: 'f1' } }, 'Where is the error?');
    assert.equal(typeof result, 'string');
    assert.ok(result.includes('line 42'));
  });

  it('builds conversation history from prior exchanges (D9)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('answer');
    a._client = mock;
    await a.clarify(
      { finding: { id: 'f1' }, diagnosis: { rootCause: 'x' } },
      'Follow-up question',
      [{ question: 'First question', answer: 'First answer' }]
    );
    const messages = mock._calls[0].messages;
    // history: [context, assistant, prior-q, prior-a, new-q]
    const lastMsg = messages[messages.length - 1];
    assert.equal(lastMsg.content, 'Follow-up question');
    const priorQ = messages.find(m => m.content === 'First question');
    assert.ok(priorQ);
  });

  it('uses max_tokens 2048 (D9)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('answer');
    a._client = mock;
    await a.clarify({ finding: { id: 'f1' } }, 'question');
    assert.equal(mock._calls[0].max_tokens, 2048);
  });
});

// ── D1 D9: suggestTitle ──────────────────────

describe('ClaudeAIAdapter.suggestTitle (D1 D9)', () => {
  it('returns parsed title object', async () => {
    const a = makeAdapter();
    a._client = makeMockClient('{"title":"Login button broken","description":"desc","type":"bug","severity":"high"}');
    const result = await a.suggestTitle({ description: 'login fails', pageUrl: '/login' });
    assert.equal(result.title, 'Login button broken');
    assert.equal(result.severity, 'high');
  });

  it('uses max_tokens 512 (D9)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.suggestTitle({ description: 'broken' });
    assert.equal(mock._calls[0].max_tokens, 512);
  });

  it('includes pageUrl in prompt when provided (D8)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.suggestTitle({ pageUrl: '/dashboard', description: 'Chart fails' });
    const userMsg = mock._calls[0].messages[0].content;
    assert.ok(userMsg.includes('/dashboard'));
  });

  it('includes element info when provided (D8)', async () => {
    const a = makeAdapter();
    const mock = makeMockClient('{}');
    a._client = mock;
    await a.suggestTitle({
      description: 'button broken',
      element: { tagName: 'BUTTON', id: 'submit', textContent: 'Submit Form' },
    });
    const userMsg = mock._calls[0].messages[0].content;
    assert.ok(userMsg.includes('BUTTON'));
    assert.ok(userMsg.includes('submit'));
  });
});
