import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AdapterRequest,
  AdapterResponse,
  ChatCompletionResponse,
  EmberSynthConfig,
  HealthStatus,
  NodeDefinition,
  ProviderAdapter,
} from '../src/types/index.js';
import type { ToolCall } from '../src/types/tools.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { handleCompletions } from '../src/api/completions.js';
import { DEFAULT_POLICY, DEFAULT_PROFILES, SYNTHETIC_MODEL_MAP } from '../src/config/defaults.js';
import { NodeRegistry } from '../src/registry/registry.js';

/** Non-streaming fake: no sendStreamingRequest; counts calls and returns a fixed reply. */
class CompletionsFakeAdapter implements ProviderAdapter {
  readonly type = 'completions-fake';
  calls = 0;
  private readonly response: AdapterResponse;

  constructor(response: AdapterResponse) {
    this.response = response;
  }

  async sendRequest(_node: NodeDefinition, _request: AdapterRequest): Promise<AdapterResponse> {
    this.calls += 1;
    return this.response;
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

interface ErrorBody {
  error: { message: string; type: string; detail?: string };
}

interface Setup {
  adapter: CompletionsFakeAdapter;
  config: EmberSynthConfig;
  registry: NodeRegistry;
}

let tempDir = '';
let previousEvidencePath: string | undefined;

function makeNode(): NodeDefinition {
  return {
    id: 'completions-1',
    label: 'Completions fake node',
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    providerType: 'completions-fake',
  };
}

/** Registers a fake adapter returning `response` and loads one reasoning node. */
function setup(response: AdapterResponse): Setup {
  const adapter = new CompletionsFakeAdapter(response);
  registerAdapter(adapter);
  const node = makeNode();
  const registry = new NodeRegistry();
  registry.load([node]);
  const config: EmberSynthConfig = {
    server: { host: '127.0.0.1', port: 0 },
    nodes: [node],
    profiles: DEFAULT_PROFILES,
    policy: { ...DEFAULT_POLICY, retryDelayMs: 1 },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };
  return { adapter, config, registry };
}

function post(body: string): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

const okBody = JSON.stringify({ model: 'fusion-auto', messages: [{ role: 'user', content: 'hi' }] });

const weatherCall: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' },
};

async function readError(res: Response, status: number): Promise<ErrorBody> {
  expect(res.status).toBe(status);
  return (await res.json()) as ErrorBody;
}

async function readCompletion(res: Response): Promise<ChatCompletionResponse> {
  expect(res.status).toBe(200);
  return (await res.json()) as ChatCompletionResponse;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'embersynth-completions-'));
  previousEvidencePath = process.env.EMBERSYNTH_EVIDENCE_PATH;
  process.env.EMBERSYNTH_EVIDENCE_PATH = join(tempDir, 'evidence.jsonl');
});

afterEach(() => {
  resetAdapters();
  if (previousEvidencePath === undefined) {
    delete process.env.EMBERSYNTH_EVIDENCE_PATH;
  } else {
    process.env.EMBERSYNTH_EVIDENCE_PATH = previousEvidencePath;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe('handleCompletions request validation (#22)', () => {
  test('an unparseable body is a 400 invalid_request_error', async () => {
    const { adapter, config, registry } = setup({ content: 'x', finishReason: 'stop' });

    const body = await readError(await handleCompletions(post('not json'), config, registry), 400);

    expect(body.error).toEqual({ message: 'Invalid JSON body', type: 'invalid_request_error' });
    expect(adapter.calls).toBe(0);
  });

  test('a missing model is a 400 invalid_request_error', async () => {
    const { adapter, config, registry } = setup({ content: 'x', finishReason: 'stop' });
    const req = post(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = await readError(await handleCompletions(req, config, registry), 400);

    expect(body.error).toEqual({ message: 'Missing required field: model', type: 'invalid_request_error' });
    expect(adapter.calls).toBe(0);
  });

  test('an empty messages array is a 400 invalid_request_error', async () => {
    const { adapter, config, registry } = setup({ content: 'x', finishReason: 'stop' });
    const req = post(JSON.stringify({ model: 'fusion-auto', messages: [] }));

    const body = await readError(await handleCompletions(req, config, registry), 400);

    expect(body.error).toEqual({ message: 'Missing required field: messages', type: 'invalid_request_error' });
    expect(adapter.calls).toBe(0);
  });

  test('a non-array messages value is a 400 invalid_request_error', async () => {
    const { adapter, config, registry } = setup({ content: 'x', finishReason: 'stop' });
    const req = post(JSON.stringify({ model: 'fusion-auto', messages: 'hi' }));

    const body = await readError(await handleCompletions(req, config, registry), 400);

    expect(body.error).toEqual({ message: 'Missing required field: messages', type: 'invalid_request_error' });
    expect(adapter.calls).toBe(0);
  });

  test('an unknown model is a 400 api_error from the router', async () => {
    const { adapter, config, registry } = setup({ content: 'x', finishReason: 'stop' });
    const req = post(JSON.stringify({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }));

    const body = await readError(await handleCompletions(req, config, registry), 400);

    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toContain('Unknown model "nope"');
    expect(adapter.calls).toBe(0);
  });
});

describe('handleCompletions non-streaming response mapping (#22)', () => {
  test('passes content and finish_reason through and echoes the requested model', async () => {
    const { adapter, config, registry } = setup({ content: 'partial answer', finishReason: 'length' });

    const body = await readCompletion(await handleCompletions(post(okBody), config, registry));

    expect(adapter.calls).toBe(1);
    expect(body.object).toBe('chat.completion');
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.model).toBe('fusion-auto');
    expect(Number.isInteger(body.created)).toBe(true);
    expect(body.choices).toHaveLength(1);
    expect(body.choices[0].index).toBe(0);
    expect(body.choices[0].finish_reason).toBe('length');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('partial answer');
  });

  test('includes tool_calls when the adapter returns them', async () => {
    const { config, registry } = setup({ content: '', finishReason: 'tool_calls', toolCalls: [weatherCall] });

    const body = await readCompletion(await handleCompletions(post(okBody), config, registry));

    expect(body.choices[0].message.tool_calls).toEqual([weatherCall]);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
  });

  test('omits tool_calls when the adapter returns none', async () => {
    const { config, registry } = setup({ content: 'plain', finishReason: 'stop' });

    const body = await readCompletion(await handleCompletions(post(okBody), config, registry));

    expect('tool_calls' in body.choices[0].message).toBe(false);
  });

  test('maps adapter usage to snake_case token counts', async () => {
    const usage = { promptTokens: 3, completionTokens: 5, totalTokens: 8 };
    const { config, registry } = setup({ content: 'counted', finishReason: 'stop', usage });

    const body = await readCompletion(await handleCompletions(post(okBody), config, registry));

    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 });
  });

  test('omits usage when the adapter reports none', async () => {
    const { config, registry } = setup({ content: 'uncounted', finishReason: 'stop' });

    const body = await readCompletion(await handleCompletions(post(okBody), config, registry));

    expect('usage' in body).toBe(false);
  });

  test('sets the orchestration headers', async () => {
    const { config, registry } = setup({ content: 'x', finishReason: 'stop' });

    const res = await handleCompletions(post(okBody), config, registry);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('X-EmberSynth-Stages')).toBe('1');
    expect(res.headers.get('X-EmberSynth-Profile')).toBe('auto');
    expect(res.headers.get('X-EmberSynth-Plan-Id')).toMatch(/^plan-/);
    expect(res.headers.get('X-EmberSynth-Duration-Ms')).toMatch(/^\d+$/);
  });
});
