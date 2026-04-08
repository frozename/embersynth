import { describe, test, expect, afterAll } from 'bun:test';
import { createTestHarness } from './mock-server.js';
import type { TestHarness } from './mock-server.js';

// ── Harness lifecycle ──

let harness: TestHarness;

afterAll(() => {
  harness?.stop();
});

describe('embeddings integration', () => {
  test('routes to embedding-capable node', async () => {
    const mockEmbeddings = [
      [0.01, 0.02, 0.03, 0.04, 0.05],
      [0.11, 0.12, 0.13, 0.14, 0.15],
    ];

    harness = createTestHarness([
      { id: 'reasoning-emb', capabilities: ['reasoning'] },
      {
        id: 'embedding-node',
        capabilities: ['embedding'],
        options: { embeddings: mockEmbeddings },
      },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        input: ['Hello world', 'Second text'],
      }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(2);

    // Verify embedding structure
    expect(body.data[0].object).toBe('embedding');
    expect(body.data[0].index).toBe(0);
    expect(body.data[0].embedding).toEqual(mockEmbeddings[0]);

    expect(body.data[1].object).toBe('embedding');
    expect(body.data[1].index).toBe(1);
    expect(body.data[1].embedding).toEqual(mockEmbeddings[1]);

    // Verify model is echoed back
    expect(body.model).toBe('fusion-auto');

    // Verify usage is present
    expect(body.usage).toBeDefined();
    expect(body.usage.prompt_tokens).toBeGreaterThanOrEqual(0);
    expect(body.usage.total_tokens).toBeGreaterThanOrEqual(0);

    // Verify the node ID header
    const nodeIdHeader = res.headers.get('X-EmberSynth-Node-Id');
    expect(nodeIdHeader).toBe('embedding-node');

    // Verify the mock received the request
    const embeddingNode = harness.mockNodes[1];
    const embReqs = embeddingNode.requestLog.filter((r) => r.path === '/v1/embeddings');
    expect(embReqs.length).toBe(1);

    harness.stop();
  });

  test('returns 503 when no embedding node available', async () => {
    // Only a reasoning node, no embedding capability
    harness = createTestHarness([
      { id: 'reasoning-only', capabilities: ['reasoning'] },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        input: 'Hello world',
      }),
    });

    expect(res.status).toBe(503);

    const body = (await res.json()) as Record<string, any>;
    expect(body.error).toBeDefined();
    expect(body.error.message).toContain('embedding');

    // No requests should have reached the reasoning node for embeddings
    const reasoningNode = harness.mockNodes[0];
    const embReqs = reasoningNode.requestLog.filter((r) => r.path === '/v1/embeddings');
    expect(embReqs.length).toBe(0);

    harness.stop();
  });
});
