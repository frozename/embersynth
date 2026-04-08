import { describe, test, expect } from 'bun:test';
import type { ProviderAdapter, NodeDefinition, AdapterRequest, AdapterResponse, HealthStatus } from '../src/types/index.js';
import { registerAdapter } from '../src/adapters/index.js';

// Mock streaming adapter for testing
class MockStreamingAdapter implements ProviderAdapter {
  readonly type = 'mock-streaming';
  private chunks: string[];

  constructor(chunks: string[]) {
    this.chunks = chunks;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    return {
      content: this.chunks.join(''),
      finishReason: 'stop',
    };
  }

  async *sendStreamingRequest(_node: NodeDefinition, _request: AdapterRequest): AsyncGenerator<string> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return {
      nodeId: node.id,
      state: 'healthy',
      consecutiveFailures: 0,
    };
  }
}

describe('streaming adapter', () => {
  test('mock streaming adapter yields chunks', async () => {
    const adapter = new MockStreamingAdapter(['Hello', ' ', 'world', '!']);
    registerAdapter(adapter);

    const mockNode: NodeDefinition = {
      id: 'mock-1',
      label: 'Mock',
      endpoint: 'http://localhost:9999',
      transport: 'http',
      enabled: true,
      capabilities: ['reasoning'],
      tags: [],
      auth: { type: 'none' },
      health: {},
      timeout: {},
      priority: 1,
      providerType: 'mock-streaming',
    };

    const chunks: string[] = [];
    const gen = adapter.sendStreamingRequest!(mockNode, {
      messages: [{ role: 'user', content: 'test' }],
    });

    for await (const chunk of gen) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['Hello', ' ', 'world', '!']);
  });

  test('non-streaming returns full content', async () => {
    const adapter = new MockStreamingAdapter(['Hello', ' ', 'world']);

    const mockNode: NodeDefinition = {
      id: 'mock-2',
      label: 'Mock',
      endpoint: 'http://localhost:9999',
      transport: 'http',
      enabled: true,
      capabilities: ['reasoning'],
      tags: [],
      auth: { type: 'none' },
      health: {},
      timeout: {},
      priority: 1,
      providerType: 'mock-streaming',
    };

    const response = await adapter.sendRequest(mockNode, {
      messages: [{ role: 'user', content: 'test' }],
    });

    expect(response.content).toBe('Hello world');
  });
});
