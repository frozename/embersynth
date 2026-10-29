import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleResponses } from '../src/api/responses.js';
import { registerAdapter, resetAdapters } from '../src/adapters/index.js';
import { TOOL_CALLS_MARKER } from '../src/adapters/stream-markers.js';
import { NodeRegistry } from '../src/registry/registry.js';
import { DEFAULT_PROFILES, DEFAULT_POLICY, SYNTHETIC_MODEL_MAP } from '../src/config/defaults.js';
import type { ProviderAdapter, NodeDefinition, AdapterRequest, AdapterResponse, HealthStatus, EmberSynthConfig } from '../src/types/index.js';

// #22: pin how handleResponses translates Responses input into chat messages
// and chat output (text, tool calls, usage) back into Responses items, for the
// non-streaming JSON body and the streaming SSE events. The adapter is an
// in-process fake; nothing touches the network.

let tempDir = '';
let previousEvidencePath: string | undefined;

/** Returns `reply` from sendRequest, yields `chunks` from sendStreamingRequest, and records every request. */
class ScriptedAdapter implements ProviderAdapter {
  readonly type = 'mock-resp-tools';
  readonly requests: AdapterRequest[] = [];
  private readonly reply: AdapterResponse;
  private readonly chunks: string[];

  constructor(reply: AdapterResponse, chunks: string[] = []) {
    this.reply = reply;
    this.chunks = chunks;
  }

  async sendRequest(_node: NodeDefinition, request: AdapterRequest): Promise<AdapterResponse> {
    this.requests.push(request);
    return this.reply;
  }

  async *sendStreamingRequest(_node: NodeDefinition, request: AdapterRequest): AsyncGenerator<string> {
    this.requests.push(request);
    for (const chunk of this.chunks) yield chunk;
  }

  async checkHealth(node: NodeDefinition): Promise<HealthStatus> {
    return { nodeId: node.id, state: 'healthy', consecutiveFailures: 0 };
  }
}

type ResponsesBody = {
  id: string;
  object: string;
  model: string;
  output: { type: string; id: string; role: string; content: unknown }[];
  usage?: unknown;
};

type SseEvent = { event: string; data: unknown };

function makeNode(): NodeDefinition {
  return {
    id: 'tools-node',
    label: 'Tools node',
    endpoint: 'http://127.0.0.1:9',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: { type: 'none' },
    health: {},
    timeout: {},
    priority: 10,
    modelId: 'mock-tools',
    providerType: 'mock-resp-tools',
  };
}

function makeConfig(node: NodeDefinition): EmberSynthConfig {
  return {
    server: { host: '127.0.0.1', port: 0 },
    nodes: [node],
    profiles: DEFAULT_PROFILES,
    policy: { ...DEFAULT_POLICY, requireHealthy: false, retryDelayMs: 0 },
    syntheticModels: SYNTHETIC_MODEL_MAP,
  };
}

/** Registers `adapter` and calls the handler in-process with `payload` as the JSON body. */
async function run(adapter: ScriptedAdapter, payload: Record<string, unknown>): Promise<Response> {
  registerAdapter(adapter);
  const node = makeNode();
  const registry = new NodeRegistry();
  registry.load([node]);
  const req = new Request('http://local/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponses(req, makeConfig(node), registry);
}

/** Splits an SSE body into its `event:` name and parsed `data:` JSON, in order. */
function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (block.trim() === '') continue;
    let event = '';
    let data: unknown = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice('event: '.length);
      if (line.startsWith('data: ')) data = JSON.parse(line.slice('data: '.length));
    }
    events.push({ event, data });
  }
  return events;
}

const WEATHER_CALL = {
  id: 'call_1',
  type: 'function' as const,
  function: { name: 'get_weather', arguments: '{"city":"Lisbon"}' },
};
const TIME_CALL = {
  id: 'call_2',
  type: 'function' as const,
  function: { name: 'get_time', arguments: '{}' },
};
const TOOLS = [{ type: 'function' as const, function: { name: 'get_weather', parameters: { type: 'object' } } }];

describe('/v1/responses translation (#22)', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'embersynth-resp-tools-'));
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

  test('instructions become a leading system message and a string input one user message', async () => {
    const adapter = new ScriptedAdapter({ content: 'ok', finishReason: 'stop' });
    const res = await run(adapter, {
      model: 'fusion-auto',
      instructions: 'be terse',
      input: 'hi',
      temperature: 0.2,
      max_output_tokens: 64,
    });
    expect(res.status).toBe(200);
    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
    ]);
    expect(adapter.requests[0].temperature).toBe(0.2);
    expect(adapter.requests[0].maxTokens).toBe(64);
  });

  test('an array input without instructions is forwarded message by message, in order', async () => {
    const adapter = new ScriptedAdapter({ content: 'ok', finishReason: 'stop' });
    const res = await run(adapter, {
      model: 'fusion-auto',
      input: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    expect(res.status).toBe(200);
    expect(adapter.requests[0].messages).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
  });

  test('non-streaming tool calls with empty content become function_call items only, with usage renamed', async () => {
    const adapter = new ScriptedAdapter({
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [WEATHER_CALL, TIME_CALL],
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    });
    const res = await run(adapter, { model: 'fusion-auto', input: 'weather in Lisbon?', tools: TOOLS, tool_choice: 'auto' });
    expect(res.status).toBe(200);
    expect(adapter.requests[0].tools).toEqual(TOOLS);
    expect(adapter.requests[0].toolChoice).toBe('auto');
    const body = (await res.json()) as ResponsesBody;
    expect(body.output).toHaveLength(1);
    expect(body.output[0].content).toEqual([
      { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Lisbon"}' },
      { type: 'function_call', id: 'call_2', call_id: 'call_2', name: 'get_time', arguments: '{}' },
    ]);
    expect(body.usage).toEqual({ input_tokens: 7, output_tokens: 3, total_tokens: 10 });
  });

  test('non-streaming text and a tool call give output_text first, then the function_call', async () => {
    const adapter = new ScriptedAdapter({ content: 'Checking.', finishReason: 'tool_calls', toolCalls: [WEATHER_CALL] });
    const res = await run(adapter, { model: 'fusion-auto', input: 'weather in Lisbon?' });
    const body = (await res.json()) as ResponsesBody;
    expect(body.output[0].content).toEqual([
      { type: 'output_text', text: 'Checking.' },
      { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Lisbon"}' },
    ]);
  });

  test('non-streaming text without usage gives one output_text item and no usage', async () => {
    const adapter = new ScriptedAdapter({ content: 'hi', finishReason: 'stop' });
    const res = await run(adapter, { model: 'fusion-auto', input: 'hi' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ResponsesBody;
    expect(body.object).toBe('response');
    expect(body.model).toBe('fusion-auto');
    expect(body.id).toMatch(/^resp-/);
    expect(body.output).toHaveLength(1);
    expect(body.output[0].type).toBe('message');
    expect(body.output[0].role).toBe('assistant');
    expect(body.output[0].id).toMatch(/^msg-/);
    expect(body.output[0].content).toEqual([{ type: 'output_text', text: 'hi' }]);
    expect(body.usage).toBeUndefined();
  });

  test('non-streaming empty content and no tool calls fall back to one empty output_text', async () => {
    const adapter = new ScriptedAdapter({ content: '', finishReason: 'stop' });
    const res = await run(adapter, { model: 'fusion-auto', input: 'hi' });
    const body = (await res.json()) as ResponsesBody;
    expect(body.output[0].content).toEqual([{ type: 'output_text', text: '' }]);
  });

  test('streaming text and a split tool call emit the Responses events in order', async () => {
    const firstDelta = [
      { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":' } },
    ];
    const secondDelta = [{ index: 0, function: { arguments: '"Lisbon"}' } }];
    const adapter = new ScriptedAdapter({ content: '', finishReason: 'stop' }, [
      'Hi',
      `${TOOL_CALLS_MARKER}${JSON.stringify(firstDelta)}`,
      `${TOOL_CALLS_MARKER}${JSON.stringify(secondDelta)}`,
    ]);
    const res = await run(adapter, {
      model: 'fusion-auto',
      instructions: 'be terse',
      input: 'weather in Lisbon?',
      tools: TOOLS,
      stream: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    const events = parseSse(await res.text());

    expect(adapter.requests).toHaveLength(1);
    expect(adapter.requests[0].stream).toBe(true);
    expect(adapter.requests[0].tools).toEqual(TOOLS);
    expect(adapter.requests[0].messages).toEqual([
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'weather in Lisbon?' },
    ]);

    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.delta',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.output_text.done',
      'response.completed',
    ]);
    const created = events[0].data as { id: string; object: string; model: string; output: unknown };
    expect(created.id).toMatch(/^resp-/);
    expect(created.object).toBe('response');
    expect(created.model).toBe('fusion-auto');
    expect(created.output).toEqual([]);
    const message = events[1].data as { type: string; id: string; role: string; content: unknown };
    expect(message.type).toBe('message');
    expect(message.id).toMatch(/^msg-/);
    expect(message.role).toBe('assistant');
    expect(message.content).toEqual([]);
    expect(events[2].data).toEqual({ delta: 'Hi' });
    expect(events[3].data).toEqual({ type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'get_weather' });
    expect(events[4].data).toEqual({ call_id: 'call_1', delta: '{"city":"Lisbon"}' });
    expect(events[5].data).toEqual({ call_id: 'call_1', arguments: '{"city":"Lisbon"}' });
    expect(events[6].data).toEqual({
      type: 'function_call',
      id: 'call_1',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Lisbon"}',
    });
    expect(events[7].data).toEqual({ text: 'Hi' });

    const completed = events[8].data as ResponsesBody;
    expect(completed.id).toBe(created.id);
    expect(completed.output).toHaveLength(1);
    expect(completed.output[0].id).toBe(message.id);
    expect(completed.output[0].content).toEqual([
      { type: 'output_text', text: 'Hi' },
      { type: 'function_call', id: 'call_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"Lisbon"}' },
    ]);
  });

  test('streaming with no text and no tool calls completes with one empty output_text', async () => {
    const adapter = new ScriptedAdapter({ content: '', finishReason: 'stop' }, []);
    const res = await run(adapter, { model: 'fusion-auto', input: 'hi', stream: true });
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.output_text.done',
      'response.completed',
    ]);
    expect(events[2].data).toEqual({ text: '' });
    const completed = events[3].data as ResponsesBody;
    expect(completed.output[0].content).toEqual([{ type: 'output_text', text: '' }]);
  });
});
