import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageRecordSchema } from '@nova/contracts';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import type { NodeDefinition, AdapterRequest } from '../src/types/index.js';

/**
 * N.3.3 — the OpenAI-compat adapter should append a usage record
 * to ~/.llamactl/usage/<provider>-<date>.jsonl (or $LLAMACTL_USAGE_DIR)
 * on every successful chat / embedding round-trip. Uses a Bun stub
 * upstream so no real network is needed.
 */

const STUB_PORT = 29031;
let stub: ReturnType<typeof Bun.serve> | null = null;
let usageDir = '';
const originalEnv = { ...process.env };

/**
 * Per-test override for the stub's chat-completions answer — an SSE
 * body for `stream: true` requests, or a JSON body for non-stream.
 * Reset before every test; absent override keeps the canned response.
 */
type ChatOverride = { kind: 'sse'; body: string } | { kind: 'json'; body: unknown };
let chatOverride: ChatOverride | null = null;

function sseFrame(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sseContentChunk(content: string): string {
  return sseFrame({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function sseUsageFrame(usage: Record<string, number>): string {
  return sseFrame({
    id: 'chunk-u',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
    choices: [],
    usage,
  });
}

function sseFinishChunk(finishReason: string): string {
  return sseFrame({
    id: 'chunk-f',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
}

beforeAll(() => {
  stub = Bun.serve({
    port: STUB_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/chat/completions') {
        const body = (await req.json()) as { model: string; stream?: boolean };
        if (body.stream) {
          if (chatOverride?.kind === 'sse') {
            return new Response(chatOverride.body, {
              headers: { 'Content-Type': 'text/event-stream' },
            });
          }
          return new Response('stream not tested here', { status: 400 });
        }
        if (chatOverride?.kind === 'json') {
          return Response.json(chatOverride.body);
        }
        return Response.json({
          id: 'stub-1',
          object: 'chat.completion',
          model: body.model,
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello from stub' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
        });
      }
      if (url.pathname === '/v1/embeddings') {
        const body = (await req.json()) as { model: string; input: string };
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          model: body.model,
          usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
        });
      }
      return new Response('nf', { status: 404 });
    },
  });
});

afterAll(() => { stub?.stop(true); });

beforeEach(() => {
  chatOverride = null;
  usageDir = mkdtempSync(join(tmpdir(), 'embersynth-usage-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, { LLAMACTL_USAGE_DIR: usageDir });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(usageDir, { recursive: true, force: true });
});

function fakeNode(): NodeDefinition {
  return {
    id: 'stub-node',
    label: 'Stub Node',
    endpoint: `http://127.0.0.1:${STUB_PORT}`,
    transport: 'http',
    enabled: true,
    providerType: 'openai-compatible',
    modelId: 'stub-model',
    capabilities: ['reasoning'],
    tags: [],
    priority: 0,
    auth: { type: 'bearer', token: 'sk' },
    timeout: { requestMs: 5000 },
    health: { intervalMs: 30_000, timeoutMs: 1_000 },
  };
}

async function waitForUsageFile(timeoutMs = 2000): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const files = readdirSync(usageDir).filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) return join(usageDir, files[0]!);
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

/**
 * Read + validate every JSONL row in a usage file: each must parse
 * as a V1 UsageRecord and carry no V2-only fields (`v`, `observation`)
 * — the sink is V1-only until the tracked V2-sink follow-up lands.
 */
function readUsageRows(path: string): Record<string, unknown>[] {
  const text = readFileSync(path, 'utf8').trim();
  if (text.length === 0) return [];
  return text.split('\n').map((line) => {
    const record = JSON.parse(line) as Record<string, unknown>;
    UsageRecordSchema.parse(record);
    expect('v' in record).toBe(false);
    expect('observation' in record).toBe(false);
    return record;
  });
}

async function expectNoUsageRows(waitMs = 150): Promise<void> {
  await new Promise((r) => setTimeout(r, waitMs));
  const files = readdirSync(usageDir).filter((f) => f.endsWith('.jsonl'));
  expect(files).toEqual([]);
}

describe('openai-compat adapter — usage recording (N.3.3)', () => {
  test('non-streaming chat appends a UsageRecord with route=embersynth:<node>', async () => {
    const adapter = new OpenAICompatibleAdapter();
    const req: AdapterRequest = {
      messages: [{ role: 'user', content: 'hi' }],
    };
    await adapter.sendRequest(fakeNode(), req);
    const path = await waitForUsageFile();
    expect(path).not.toBeNull();
    const rows = readUsageRows(path!);
    expect(rows).toHaveLength(1);
    const record = rows[0]!;
    expect(record.provider).toBe('stub-node');
    expect(record.model).toBe('stub-model');
    expect(record.kind).toBe('chat');
    expect(record.prompt_tokens).toBe(7);
    expect(record.completion_tokens).toBe(4);
    expect(record.total_tokens).toBe(11);
    expect(record.route).toBe('embersynth:stub-node');
    expect(typeof record.latency_ms).toBe('number');
  });

  test('embedding request records kind: embedding with completion_tokens=0', async () => {
    const adapter = new OpenAICompatibleAdapter();
    await adapter.sendEmbeddingRequest(fakeNode(), {
      input: ['abc'],
    });
    const path = await waitForUsageFile();
    expect(path).not.toBeNull();
    const rows = readUsageRows(path!);
    expect(rows).toHaveLength(1);
    const record = rows[0]!;
    expect(record.kind).toBe('embedding');
    expect(record.completion_tokens).toBe(0);
    // input was a single-element string array 'abc'; stub counts the
    // input's JSON-like length — exact count is adapter impl detail;
    // just assert it's numeric.
    expect(typeof record.prompt_tokens).toBe('number');
    expect(record.total_tokens).toBe(record.prompt_tokens);
  });

  test('EMBERSYNTH_DISABLE_USAGE suppresses the sink entirely', async () => {
    process.env.EMBERSYNTH_DISABLE_USAGE = '1';
    const adapter = new OpenAICompatibleAdapter();
    await adapter.sendRequest(fakeNode(), {
      messages: [{ role: 'user', content: 'hi' }],
    });
    // Give a window for any stray append to land.
    await new Promise((r) => setTimeout(r, 50));
    const files = readdirSync(usageDir);
    expect(files).toEqual([]);
  });
});

describe('openai-compat adapter — provenance-honest usage (P0.2)', () => {
  test('cumulative usage on every stream chunk produces exactly one V1 row carrying the last frame', async () => {
    chatOverride = {
      kind: 'sse',
      body:
        sseContentChunk('partial') +
        sseUsageFrame({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }) +
        sseContentChunk(' more') +
        sseUsageFrame({ prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 }) +
        sseUsageFrame({ prompt_tokens: 9, completion_tokens: 7, total_tokens: 16 }) +
        sseFinishChunk('stop') +
        'data: [DONE]\n\n',
    };
    const adapter = new OpenAICompatibleAdapter();
    for await (const _ of adapter.sendStreamingRequest!(fakeNode(), {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void _;
    }
    const path = await waitForUsageFile();
    expect(path).not.toBeNull();
    const rows = readUsageRows(path!);
    expect(rows).toHaveLength(1);
    const record = rows[0]!;
    expect(record.kind).toBe('chat');
    expect(record.prompt_tokens).toBe(9);
    expect(record.completion_tokens).toBe(7);
    expect(record.total_tokens).toBe(16);
    expect(record.route).toBe('embersynth:stub-node');
  });

  test('stream usage frame missing completion_tokens produces no row', async () => {
    chatOverride = {
      kind: 'sse',
      body:
        sseContentChunk('partial') +
        sseUsageFrame({ prompt_tokens: 5, total_tokens: 9 }) +
        sseFinishChunk('stop') +
        'data: [DONE]\n\n',
    };
    const adapter = new OpenAICompatibleAdapter();
    for await (const _ of adapter.sendStreamingRequest!(fakeNode(), {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void _;
    }
    await expectNoUsageRows();
  });

  test('stream with no usage frames produces no row', async () => {
    chatOverride = {
      kind: 'sse',
      body: sseContentChunk('no usage here') + sseFinishChunk('stop') + 'data: [DONE]\n\n',
    };
    const adapter = new OpenAICompatibleAdapter();
    for await (const _ of adapter.sendStreamingRequest!(fakeNode(), {
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void _;
    }
    await expectNoUsageRows();
  });

  test('non-streaming partial usage produces no row', async () => {
    chatOverride = {
      kind: 'json',
      body: {
        id: 'stub-partial',
        object: 'chat.completion',
        model: 'stub-model',
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'partial usage' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, total_tokens: 9 },
      },
    };
    const adapter = new OpenAICompatibleAdapter();
    await adapter.sendRequest(fakeNode(), {
      messages: [{ role: 'user', content: 'hi' }],
    });
    await expectNoUsageRows();
  });

  test('non-streaming response without usage produces no row', async () => {
    chatOverride = {
      kind: 'json',
      body: {
        id: 'stub-nousage',
        object: 'chat.completion',
        model: 'stub-model',
        created: 1,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'no usage' },
            finish_reason: 'stop',
          },
        ],
      },
    };
    const adapter = new OpenAICompatibleAdapter();
    await adapter.sendRequest(fakeNode(), {
      messages: [{ role: 'user', content: 'hi' }],
    });
    await expectNoUsageRows();
  });
});
