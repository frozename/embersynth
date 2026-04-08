import { describe, test, expect, afterAll } from 'bun:test';
import { createTestHarness, createTestHarnessWithTags } from './mock-server.js';
import type { TestHarness } from './mock-server.js';

// ── Harness lifecycle ──

let harness: TestHarness;

afterAll(() => {
  harness?.stop();
});

describe('completions integration', () => {
  test('text request routes to reasoning node', async () => {
    harness = createTestHarness([
      { id: 'reasoning-1', capabilities: ['reasoning'], options: { response: 'Hello from reasoning node' } },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [{ role: 'user', content: 'Hello world' }],
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.object).toBe('chat.completion');
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('Hello from reasoning node');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.model).toBe('fusion-auto');

    // Verify the mock node received the request
    const mockNode = harness.mockNodes[0];
    expect(mockNode.requestLog.length).toBeGreaterThanOrEqual(1);
    const logged = mockNode.requestLog.find((r) => r.path === '/v1/chat/completions');
    expect(logged).toBeDefined();
    expect((logged!.body as { messages: unknown[] }).messages).toHaveLength(1);

    harness.stop();
  });

  test('returns orchestration headers', async () => {
    harness = createTestHarness([
      { id: 'reasoning-h', capabilities: ['reasoning'], options: { response: 'With headers' } },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [{ role: 'user', content: 'Test headers' }],
      }),
    });

    expect(res.status).toBe(200);

    // Verify orchestration headers
    const planId = res.headers.get('X-EmberSynth-Plan-Id');
    expect(planId).toBeTruthy();
    expect(planId).toMatch(/^plan-/);

    const stages = res.headers.get('X-EmberSynth-Stages');
    expect(stages).toBe('1');

    const profile = res.headers.get('X-EmberSynth-Profile');
    expect(profile).toBe('auto');

    const durationMs = res.headers.get('X-EmberSynth-Duration-Ms');
    expect(durationMs).toBeTruthy();
    expect(Number(durationMs)).toBeGreaterThanOrEqual(0);

    harness.stop();
  });

  test('fusion-private rejects non-private nodes', async () => {
    // Set up nodes without the "private" tag
    harness = createTestHarnessWithTags([
      { id: 'reasoning-ext', capabilities: ['reasoning'], tags: ['external'], options: { response: 'Should not see this' } },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-private',
        messages: [{ role: 'user', content: 'Private query' }],
      }),
    });

    expect(res.status).toBe(503);

    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('No healthy node available');

    // The mock node should NOT have received any completion requests
    const mockNode = harness.mockNodes[0];
    const completionReqs = mockNode.requestLog.filter((r) => r.path === '/v1/chat/completions');
    expect(completionReqs.length).toBe(0);

    harness.stop();
  });

  test('fusion-fast with text-only request succeeds', async () => {
    harness = createTestHarness([
      { id: 'fast-node', capabilities: ['reasoning'], options: { response: 'Fast response' } },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-fast',
        messages: [{ role: 'user', content: 'Quick question' }],
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].message.content).toBe('Fast response');

    const profile = res.headers.get('X-EmberSynth-Profile');
    expect(profile).toBe('fast');

    const stages = res.headers.get('X-EmberSynth-Stages');
    expect(stages).toBe('1');

    harness.stop();
  });

  test('unknown model returns 400', async () => {
    harness = createTestHarness([
      { id: 'reasoning-unk', capabilities: ['reasoning'] },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'nonexistent',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('Unknown model');
    expect(body.error.message).toContain('nonexistent');

    harness.stop();
  });

  test('missing messages returns 400', async () => {
    harness = createTestHarness([
      { id: 'reasoning-mm', capabilities: ['reasoning'] },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        // messages field deliberately omitted
      }),
    });

    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('messages');

    harness.stop();
  });

  test('node failure triggers fallback', async () => {
    // Primary node fails immediately (failAfter: 0), secondary should handle
    harness = createTestHarness([
      {
        id: 'primary-fail',
        capabilities: ['reasoning'],
        options: { failAfter: 0, response: 'Should never see this' },
      },
      {
        id: 'secondary-ok',
        capabilities: ['reasoning'],
        options: { response: 'Fallback response' },
      },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [{ role: 'user', content: 'Fallback test' }],
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].message.content).toBe('Fallback response');

    // The primary node should have received request(s) that failed
    const primaryNode = harness.mockNodes[0];
    const primaryReqs = primaryNode.requestLog.filter((r) => r.path === '/v1/chat/completions');
    expect(primaryReqs.length).toBeGreaterThanOrEqual(1);

    // The secondary node should have handled the request successfully
    const secondaryNode = harness.mockNodes[1];
    const secondaryReqs = secondaryNode.requestLog.filter((r) => r.path === '/v1/chat/completions');
    expect(secondaryReqs.length).toBeGreaterThanOrEqual(1);

    harness.stop();
  });
});
