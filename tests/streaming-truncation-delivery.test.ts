import { describe, test, expect, afterEach } from 'bun:test';
import type {
  AdapterRequest,
  AdapterResponse,
  ChatMessage,
  HealthStatus,
  NodeDefinition,
  ProviderAdapter,
} from '../src/types/index.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { DEFAULT_POLICY, DEFAULT_PROFILES } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { classifyRequest } from '../src/router/classifier.js';
import { buildPlan } from '../src/router/planner.js';
import { executePlanStreaming } from '../src/router/executor.js';

/** Yields the scripted chunks, then throws `failMessage` when it is not null (an upstream truncation). */
class ScriptedStreamAdapter implements ProviderAdapter {
  readonly type: string;
  private readonly chunks: string[];
  private readonly failMessage: string | null;

  constructor(type: string, chunks: string[], failMessage: string | null) {
    this.type = type;
    this.chunks = chunks;
    this.failMessage = failMessage;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    return { content: this.chunks.join(''), finishReason: 'stop' };
  }

  async *sendStreamingRequest(_node: NodeDefinition, _request: AdapterRequest): AsyncGenerator<string> {
    for (const chunk of this.chunks) {
      yield chunk;
    }
    if (this.failMessage !== null) {
      throw new Error(this.failMessage);
    }
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

function makeNode(id: string, providerType: string): NodeDefinition {
  return {
    id,
    label: 'Scripted Node',
    endpoint: 'http://localhost:8080',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local', 'private'],
    auth: { type: 'none' },
    health: { endpoint: '/health', intervalMs: 30000, timeoutMs: 5000, unhealthyAfter: 3 },
    timeout: { requestMs: 120000, connectMs: 5000 },
    priority: 10,
    providerType,
  };
}

const autoProfile = DEFAULT_PROFILES.find((p) => p.id === 'auto')!;
const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];

interface StartedStream {
  stream: ReadableStream<Uint8Array>;
  registry: NodeRegistry;
}

interface Drained {
  text: string;
  errorMessage: string | null;
}

async function startStream(nodeId: string, adapter: ScriptedStreamAdapter): Promise<StartedStream> {
  registerAdapter(adapter);
  const registry = new NodeRegistry();
  registry.load([makeNode(nodeId, adapter.type)]);
  const planResult = buildPlan(classifyRequest(messages), autoProfile, DEFAULT_POLICY, registry);
  if (!planResult.ok) {
    throw new Error(`plan failed: ${planResult.error.message}`);
  }
  const result = await executePlanStreaming(
    planResult.plan,
    messages,
    registry,
    DEFAULT_POLICY,
    autoProfile,
    'fusion-auto',
  );
  return { stream: result.stream, registry };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Drained> {
  // Ordering barrier, not a timing sleep: the scripted adapter does only
  // microtask work, so by the next macrotask an eager start()-based stream
  // has already enqueued every chunk and errored.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let errorMessage: string | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }
  return { text, errorMessage };
}

describe('executePlanStreaming delivery', () => {
  afterEach(() => {
    resetAdapters();
  });

  test('a truncated upstream still delivers the chunks streamed before it', async () => {
    const adapter = new ScriptedStreamAdapter('mock-truncating', ['Hello', ' trunc'], 'truncated');
    const { stream, registry } = await startStream('trunc-1', adapter);

    const { text, errorMessage } = await drain(stream);

    expect(text).toContain('"role":"assistant"');
    expect(text).toContain('"content":"Hello"');
    expect(text).toContain('"content":" trunc"');
    expect(text).not.toContain('data: [DONE]');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(errorMessage).toBe('truncated');
    expect(registry.getHealth('trunc-1')?.error).toBe('truncated');
  });

  test('a complete upstream ends with finish_reason stop and [DONE] and marks the node healthy', async () => {
    const adapter = new ScriptedStreamAdapter('mock-complete', ['Hi', ' there'], null);
    const { stream, registry } = await startStream('complete-1', adapter);

    const { text, errorMessage } = await drain(stream);

    expect(errorMessage).toBeNull();
    expect(text).toContain('"content":"Hi"');
    expect(text).toContain('"content":" there"');
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(registry.getHealth('complete-1')?.state).toBe('healthy');
  });
});
