import { createServer } from '../../src/api/server.js';
import { NodeRegistry } from '../../src/registry/registry.js';
import { DEFAULT_PROFILES, DEFAULT_POLICY, SYNTHETIC_MODEL_MAP } from '../../src/config/defaults.js';
import type { EmberSynthConfig, NodeDefinition, Capability } from '../../src/types/index.js';

// ── Mock Node types ──

export interface MockNodeOptions {
  capabilities?: string[];
  response?: string;
  latencyMs?: number;
  failAfter?: number; // fail after N requests (for testing fallback)
  modelId?: string;
  embeddings?: number[][]; // mock embedding vectors
}

export interface MockNode {
  port: number;
  url: string;
  server: ReturnType<typeof Bun.serve>;
  requestLog: { path: string; body: unknown }[];
  stop(): void;
}

// ── Test Harness types ──

export interface TestHarness {
  embersynth: { port: number; url: string; server: ReturnType<typeof Bun.serve> };
  mockNodes: MockNode[];
  stop(): void;
}

// ── Mock Node factory ──

export function createMockNode(options?: MockNodeOptions): MockNode {
  const opts = options ?? {};
  const responseText = opts.response ?? 'Mock response from test node';
  const latencyMs = opts.latencyMs ?? 0;
  const failAfter = opts.failAfter;
  const modelId = opts.modelId ?? 'mock-model';
  const embeddings = opts.embeddings ?? [[0.1, 0.2, 0.3, 0.4, 0.5]];

  const requestLog: { path: string; body: unknown }[] = [];
  let requestCount = 0;

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0, // OS-assigned dynamic port

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      // Health check
      if (method === 'GET' && path === '/health') {
        return Response.json({ status: 'ok' });
      }

      // Parse body for POST requests
      let body: unknown = null;
      if (method === 'POST') {
        try {
          body = await req.json();
        } catch {
          body = null;
        }
        requestLog.push({ path, body });
      }

      // Check if we should fail
      if (failAfter !== undefined && requestCount >= failAfter) {
        requestCount++;
        return Response.json(
          { error: { message: 'Simulated failure', type: 'server_error' } },
          { status: 500 },
        );
      }
      requestCount++;

      // Apply latency
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs));
      }

      // POST /v1/chat/completions
      if (method === 'POST' && path === '/v1/chat/completions') {
        return Response.json({
          id: `chatcmpl-mock-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: responseText,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          },
        });
      }

      // POST /v1/embeddings
      if (method === 'POST' && path === '/v1/embeddings') {
        const input = (body as { input?: string[] })?.input ?? [''];
        return Response.json({
          object: 'list',
          data: input.map((_, index) => ({
            object: 'embedding',
            embedding: embeddings[index % embeddings.length],
            index,
          })),
          model: modelId,
          usage: {
            prompt_tokens: 5,
            total_tokens: 5,
          },
        });
      }

      return Response.json(
        { error: { message: 'Not found', type: 'invalid_request_error' } },
        { status: 404 },
      );
    },
  });

  const port = server.port as number;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    server,
    requestLog,
    stop() {
      server.stop(true);
    },
  };
}

// ── Test Harness factory ──

export function createTestHarness(
  nodes: { id: string; capabilities: string[]; options?: MockNodeOptions }[],
): TestHarness {
  // Create mock nodes
  const mockNodes: MockNode[] = [];
  const nodeDefinitions: NodeDefinition[] = [];

  for (const entry of nodes) {
    const mockOpts: MockNodeOptions = {
      ...entry.options,
      capabilities: entry.capabilities,
    };
    const mockNode = createMockNode(mockOpts);
    mockNodes.push(mockNode);

    nodeDefinitions.push({
      id: entry.id,
      label: `Mock ${entry.id}`,
      endpoint: mockNode.url,
      transport: 'http',
      enabled: true,
      capabilities: entry.capabilities as Capability[],
      tags: entry.options?.modelId === 'private-model' ? ['private'] : (entry.capabilities.includes('reasoning') ? ['local'] : []),
      auth: { type: 'none' },
      health: {
        endpoint: '/health',
        intervalMs: 30_000,
        timeoutMs: 5_000,
        unhealthyAfter: 3,
      },
      timeout: {
        requestMs: 30_000,
        connectMs: 5_000,
      },
      priority: 10,
      modelId: entry.options?.modelId ?? `mock-${entry.id}`,
      providerType: 'openai-compatible',
    });
  }

  // Build config
  const config: EmberSynthConfig = {
    server: {
      host: '127.0.0.1',
      port: 0, // OS-assigned
    },
    nodes: nodeDefinitions,
    profiles: DEFAULT_PROFILES,
    policy: {
      ...DEFAULT_POLICY,
      requireHealthy: false, // don't require health checks in tests
      retryDelayMs: 50, // fast retries in tests
    },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };

  // Build registry and load nodes
  const registry = new NodeRegistry();
  registry.load(nodeDefinitions);

  // Start EmberSynth server
  const embersynthServer = createServer(config, registry);
  const embersynthPort = embersynthServer.port as number;

  return {
    embersynth: {
      port: embersynthPort,
      url: `http://127.0.0.1:${embersynthPort}`,
      server: embersynthServer,
    },
    mockNodes,
    stop() {
      embersynthServer.stop(true);
      for (const mn of mockNodes) {
        mn.stop();
      }
    },
  };
}

// ── Harness factory with tag support ──

export function createTestHarnessWithTags(
  nodes: { id: string; capabilities: string[]; tags: string[]; priority?: number; options?: MockNodeOptions }[],
): TestHarness {
  const mockNodes: MockNode[] = [];
  const nodeDefinitions: NodeDefinition[] = [];

  for (const entry of nodes) {
    const mockOpts: MockNodeOptions = {
      ...entry.options,
      capabilities: entry.capabilities,
    };
    const mockNode = createMockNode(mockOpts);
    mockNodes.push(mockNode);

    nodeDefinitions.push({
      id: entry.id,
      label: `Mock ${entry.id}`,
      endpoint: mockNode.url,
      transport: 'http',
      enabled: true,
      capabilities: entry.capabilities as Capability[],
      tags: entry.tags,
      auth: { type: 'none' },
      health: {
        endpoint: '/health',
        intervalMs: 30_000,
        timeoutMs: 5_000,
        unhealthyAfter: 3,
      },
      timeout: {
        requestMs: 30_000,
        connectMs: 5_000,
      },
      priority: entry.priority ?? 10,
      modelId: entry.options?.modelId ?? `mock-${entry.id}`,
      providerType: 'openai-compatible',
    });
  }

  const config: EmberSynthConfig = {
    server: {
      host: '127.0.0.1',
      port: 0,
    },
    nodes: nodeDefinitions,
    profiles: DEFAULT_PROFILES,
    policy: {
      ...DEFAULT_POLICY,
      requireHealthy: false,
      retryDelayMs: 50,
    },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };

  const registry = new NodeRegistry();
  registry.load(nodeDefinitions);

  const embersynthServer = createServer(config, registry);
  const embersynthPort = embersynthServer.port as number;

  return {
    embersynth: {
      port: embersynthPort,
      url: `http://127.0.0.1:${embersynthPort}`,
      server: embersynthServer,
    },
    mockNodes,
    stop() {
      embersynthServer.stop(true);
      for (const mn of mockNodes) {
        mn.stop();
      }
    },
  };
}
