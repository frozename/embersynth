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

// #36: input is validated before routing, so a bad request never reaches a node or its health.
type ErrorBody = { error: { message: string; type: string } };
type MetricsBody = { node_details: { id: string; health: string; consecutive_failures: number }[] };

async function postEmbeddings(h: TestHarness, payload: string): Promise<Response> {
  return fetch(`${h.embersynth.url}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
}

describe('embeddings input validation (#36)', () => {
  test('an empty input array returns 400 and never reaches the embedding node', async () => {
    const h = createTestHarness([{ id: 'embedding-node', capabilities: ['embedding'] }]);
    try {
      const res = await postEmbeddings(h, JSON.stringify({ model: 'fusion-auto', input: [] }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toBe('Missing required field: input');
      expect(h.mockNodes[0].requestLog.filter((r) => r.path === '/v1/embeddings').length).toBe(0);
      const metrics = (await (await fetch(`${h.embersynth.url}/metrics`)).json()) as MetricsBody;
      const node = metrics.node_details.find((n) => n.id === 'embedding-node');
      expect(node?.health).toBe('unknown');
      expect(node?.consecutive_failures).toBe(0);
    } finally {
      h.stop();
    }
  });

  test('numeric input returns 400, not 503, when no embedding node is configured', async () => {
    const h = createTestHarness([{ id: 'reasoning-only', capabilities: ['reasoning'] }]);
    try {
      const res = await postEmbeddings(h, JSON.stringify({ model: 'fusion-auto', input: [1, 2] }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toBe('Invalid field: input');
    } finally {
      h.stop();
    }
  });

  test('numeric input is rejected before routing when an embedding node exists', async () => {
    const h = createTestHarness([{ id: 'embedding-node', capabilities: ['embedding'] }]);
    try {
      const res = await postEmbeddings(h, JSON.stringify({ model: 'fusion-auto', input: [[1, 2]] }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.message).toBe('Invalid field: input');
      expect(body.error.type).toBe('invalid_request_error');
      expect(h.mockNodes[0].requestLog.filter((r) => r.path === '/v1/embeddings').length).toBe(0);
    } finally {
      h.stop();
    }
  });

  test('a JSON null body returns 400 instead of 500', async () => {
    const h = createTestHarness([{ id: 'embedding-node', capabilities: ['embedding'] }]);
    try {
      const res = await postEmbeddings(h, 'null');
      expect(res.status).toBe(400);
      const body = (await res.json()) as ErrorBody;
      expect(body.error.type).toBe('invalid_request_error');
      expect(body.error.message).toBe('Request body must be a JSON object');
    } finally {
      h.stop();
    }
  });

  test('a single string input still reaches the embedding node', async () => {
    const h = createTestHarness([{ id: 'embedding-node', capabilities: ['embedding'] }]);
    try {
      const res = await postEmbeddings(h, JSON.stringify({ model: 'fusion-auto', input: 'Hello world' }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: unknown[] };
      expect(body.data).toHaveLength(1);
      expect(h.mockNodes[0].requestLog.filter((r) => r.path === '/v1/embeddings').length).toBe(1);
    } finally {
      h.stop();
    }
  });
});
