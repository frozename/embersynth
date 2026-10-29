import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { GenericHttpAdapter } from '../src/adapters/generic-http.js';
import type { AdapterRequest, EvidenceBundle, NodeDefinition } from '../src/types/index.js';

// Pins GenericHttpAdapter (src/adapters/generic-http.ts): the /generate request it builds,
// the response mapping, the non-ok rejection and the checkHealth status mapping.
// globalThis.fetch is swapped for a recording fake that settles at once (no network,
// no timers), and the real fetch is put back in afterEach even when a case fails.

function makeNode(overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    id: 'gh-node',
    label: 'Generic Node',
    endpoint: 'http://gh.local:9000',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: { type: 'header', headerName: 'X-Trace-Tag', headerValue: 'tag-7731' },
    health: { endpoint: '/ready', intervalMs: 30000, timeoutMs: 5000, unhealthyAfter: 3 },
    timeout: { requestMs: 120000, connectMs: 5000 },
    priority: 10,
    providerType: 'generic-http',
    ...overrides,
  };
}

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: RequestInit['headers'];
  body: string | undefined;
  signal: AbortSignal | null | undefined;
  abortedAtCall: boolean;
}

type Reply = () => Promise<Response>;

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let reply: Reply = () => Promise.resolve(jsonResponse({}));

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function installFakeFetch(): void {
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      url: urlOf(input),
      method: init?.method,
      headers: init?.headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal,
      abortedAtCall: init?.signal?.aborted ?? false,
    });
    return reply();
  };
  globalThis.fetch = Object.assign(impl, { preconnect: realFetch.preconnect.bind(realFetch) });
}

function onlyCall(): FetchCall {
  expect(calls.length).toBe(1);
  const call = calls[0];
  if (call === undefined) throw new Error('fetch was not called');
  return call;
}

function sentBody(call: FetchCall): Record<string, unknown> {
  const parsed: unknown = JSON.parse(call.body ?? 'null');
  if (typeof parsed !== 'object' || parsed === null) throw new Error('request body is not a JSON object');
  return parsed as Record<string, unknown>;
}

const minimalRequest: AdapterRequest = {
  messages: [{ role: 'user', content: 'hi' }],
};

beforeEach(() => {
  calls = [];
  reply = () => Promise.resolve(jsonResponse({}));
  installFakeFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GenericHttpAdapter.sendRequest request building', () => {
  test('POSTs JSON to <endpoint>/generate with the buildHeaders headers and a live signal', async () => {
    reply = () => Promise.resolve(jsonResponse({ content: 'ok' }));
    const adapter = new GenericHttpAdapter();

    await adapter.sendRequest(makeNode(), minimalRequest);

    const call = onlyCall();
    expect(call.url).toBe('http://gh.local:9000/generate');
    expect(call.method).toBe('POST');
    expect(call.headers).toEqual({ 'Content-Type': 'application/json', 'X-Trace-Tag': 'tag-7731' });
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.abortedAtCall).toBe(false);
  });

  test('prompt joins messages as role: content, with null as empty and image parts as [image]', async () => {
    const adapter = new GenericHttpAdapter();
    const request: AdapterRequest = {
      messages: [
        { role: 'system', content: 'be brief' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look ' },
            { type: 'image_url', image_url: { url: 'http://img.local/cat.png' } },
            { type: 'text', text: ' here' },
          ],
        },
        { role: 'assistant', content: null },
        { role: 'tool', content: '42', tool_call_id: 'call-1' },
      ],
    };

    await adapter.sendRequest(makeNode(), request);

    expect(sentBody(onlyCall()).prompt).toBe(
      'system: be brief\nuser: look [image] here\nassistant: \ntool: 42',
    );
  });

  test('maps temperature, maxTokens, systemPromptOverride, tools, toolChoice and evidence', async () => {
    const adapter = new GenericHttpAdapter();
    const evidence: EvidenceBundle = {
      planId: 'plan-1',
      items: [
        {
          stageIndex: 0,
          nodeId: 'vision-node',
          capability: 'vision',
          content: 'a cat on a mat',
          metadata: { model: 'v1' },
          durationMs: 12,
          timestamp: 1700000000000,
        },
        {
          stageIndex: 1,
          nodeId: 'memory-node',
          capability: 'memory',
          content: 'the cat is called Tom',
          durationMs: 3,
          timestamp: 1700000000500,
        },
      ],
      totalDurationMs: 15,
    };
    const request: AdapterRequest = {
      messages: [{ role: 'user', content: 'who is this?' }],
      temperature: 0.2,
      maxTokens: 64,
      systemPromptOverride: 'answer from the evidence',
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
      toolChoice: { type: 'function', function: { name: 'lookup' } },
      evidence,
    };

    await adapter.sendRequest(makeNode(), request);

    const body = sentBody(onlyCall());
    expect(Object.keys(body).sort()).toEqual([
      'evidence',
      'max_tokens',
      'prompt',
      'system_prompt',
      'temperature',
      'tool_choice',
      'tools',
    ]);
    expect(body.prompt).toBe('user: who is this?');
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(64);
    expect(body.system_prompt).toBe('answer from the evidence');
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } },
    ]);
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'lookup' } });
    expect(body.evidence).toEqual([
      { source: 'vision-node', capability: 'vision', content: 'a cat on a mat' },
      { source: 'memory-node', capability: 'memory', content: 'the cat is called Tom' },
    ]);
  });

  test('optional fields that are not given are left out of the JSON body', async () => {
    const adapter = new GenericHttpAdapter();

    await adapter.sendRequest(makeNode(), minimalRequest);

    expect(Object.keys(sentBody(onlyCall()))).toEqual(['prompt']);
  });

  test('an already-aborted caller signal reaches fetch', async () => {
    const adapter = new GenericHttpAdapter();
    const caller = new AbortController();
    caller.abort();

    await adapter.sendRequest(makeNode(), minimalRequest, caller.signal);

    const call = onlyCall();
    expect(call.signal).toBeInstanceOf(AbortSignal);
    expect(call.abortedAtCall).toBe(true);
  });
});

describe('GenericHttpAdapter.sendRequest response mapping', () => {
  test('a body without content or finish_reason maps to empty content and stop', async () => {
    reply = () => Promise.resolve(jsonResponse({}));
    const adapter = new GenericHttpAdapter();

    const res = await adapter.sendRequest(makeNode(), minimalRequest);

    expect(res.content).toBe('');
    expect(res.finishReason).toBe('stop');
    expect(res.toolCalls).toBeUndefined();
  });

  test('content and a given finish_reason pass through', async () => {
    reply = () => Promise.resolve(jsonResponse({ content: 'cut sho', finish_reason: 'length' }));
    const adapter = new GenericHttpAdapter();

    const res = await adapter.sendRequest(makeNode(), minimalRequest);

    expect(res).toEqual({ content: 'cut sho', finishReason: 'length' });
  });

  test('an empty tool_calls array maps to undefined toolCalls', async () => {
    reply = () =>
      Promise.resolve(jsonResponse({ content: 'none', finish_reason: 'stop', tool_calls: [] }));
    const adapter = new GenericHttpAdapter();

    const res = await adapter.sendRequest(makeNode(), minimalRequest);

    expect(res.toolCalls).toBeUndefined();
    expect(res.content).toBe('none');
  });

  test('a non-empty tool_calls array passes through unchanged', async () => {
    const toolCalls = [
      { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cat"}' } },
    ];
    reply = () =>
      Promise.resolve(jsonResponse({ content: '', finish_reason: 'tool_calls', tool_calls: toolCalls }));
    const adapter = new GenericHttpAdapter();

    const res = await adapter.sendRequest(makeNode(), minimalRequest);

    expect(res.toolCalls).toEqual([
      { id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"q":"cat"}' } },
    ]);
    expect(res.finishReason).toBe('tool_calls');
  });

  test('a non-ok status rejects naming the node and the status', async () => {
    reply = () => Promise.resolve(jsonResponse({ error: 'overloaded' }, 500));
    const adapter = new GenericHttpAdapter();

    await expect(adapter.sendRequest(makeNode(), minimalRequest)).rejects.toThrow(
      'Node gh-node returned 500',
    );
    expect(calls.length).toBe(1);
  });
});

describe('GenericHttpAdapter.checkHealth', () => {
  test('GETs <endpoint><health.endpoint> with the buildHeaders headers', async () => {
    reply = () => Promise.resolve(new Response(null, { status: 200 }));
    const adapter = new GenericHttpAdapter();

    await adapter.checkHealth(makeNode());

    const call = onlyCall();
    expect(call.url).toBe('http://gh.local:9000/ready');
    expect(call.method).toBe('GET');
    expect(call.headers).toEqual({ 'Content-Type': 'application/json', 'X-Trace-Tag': 'tag-7731' });
    expect(call.abortedAtCall).toBe(false);
  });

  test('falls back to /health when health.endpoint is not set', async () => {
    reply = () => Promise.resolve(new Response(null, { status: 200 }));
    const adapter = new GenericHttpAdapter();

    await adapter.checkHealth(makeNode({ health: {} }));

    expect(onlyCall().url).toBe('http://gh.local:9000/health');
  });

  test('an already-aborted caller signal reaches the probe', async () => {
    reply = () => Promise.resolve(new Response(null, { status: 200 }));
    const adapter = new GenericHttpAdapter();
    const caller = new AbortController();
    caller.abort();

    await adapter.checkHealth(makeNode(), caller.signal);

    expect(onlyCall().abortedAtCall).toBe(true);
  });

  test('an ok response maps to healthy with zero failures and a lastSuccess', async () => {
    reply = () => Promise.resolve(new Response(null, { status: 200 }));
    const adapter = new GenericHttpAdapter();

    const status = await adapter.checkHealth(makeNode());

    expect(status.nodeId).toBe('gh-node');
    expect(status.state).toBe('healthy');
    expect(status.consecutiveFailures).toBe(0);
    expect(typeof status.lastCheck).toBe('number');
    expect(typeof status.lastSuccess).toBe('number');
    expect(typeof status.latencyMs).toBe('number');
    expect(status.error).toBeUndefined();
  });

  test('a non-ok response maps to unhealthy with one failure and no lastSuccess', async () => {
    reply = () => Promise.resolve(new Response(null, { status: 503 }));
    const adapter = new GenericHttpAdapter();

    const status = await adapter.checkHealth(makeNode());

    expect(status.nodeId).toBe('gh-node');
    expect(status.state).toBe('unhealthy');
    expect(status.consecutiveFailures).toBe(1);
    expect(status.lastSuccess).toBeUndefined();
    expect(typeof status.lastCheck).toBe('number');
    expect(typeof status.latencyMs).toBe('number');
    expect(status.error).toBeUndefined();
  });

  test('a rejected fetch maps to unhealthy carrying the error message', async () => {
    reply = () => Promise.reject(new Error('boom'));
    const adapter = new GenericHttpAdapter();

    const status = await adapter.checkHealth(makeNode());

    expect(status.nodeId).toBe('gh-node');
    expect(status.state).toBe('unhealthy');
    expect(status.consecutiveFailures).toBe(1);
    expect(status.error).toBe('boom');
    expect(status.lastSuccess).toBeUndefined();
    expect(status.latencyMs).toBeUndefined();
    expect(typeof status.lastCheck).toBe('number');
  });

  test('a non-Error rejection is stringified into error', async () => {
    reply = () => Promise.reject('refused-7731');
    const adapter = new GenericHttpAdapter();

    const status = await adapter.checkHealth(makeNode());

    expect(status.state).toBe('unhealthy');
    expect(status.error).toBe('refused-7731');
  });
});
