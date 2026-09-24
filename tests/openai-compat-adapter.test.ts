import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAICompatibleAdapter } from '../src/adapters/openai-compatible.js';
import { TOOL_CALLS_MARKER, FINISH_REASON_MARKER } from '../src/adapters/stream-markers.js';
import type { AdapterRequest, NodeDefinition } from '../src/types/index.js';

/**
 * P0.2 adapter contract tests — cancellation, truncation honesty.
 * Real Bun.serve upstream on port 0; fetch is not mocked.
 *
 * Cancellation: the per-node timeout signal and the caller's
 * AbortSignal must actually reach the wire fetch (previously the
 * controller was created and never handed to Nova).
 * Truncation: a stream that ends without upstream completion must
 * throw rather than masquerade as a finished response.
 */

interface StubScript {
  chatDelayMs?: number;
  embeddingsDelayMs?: number;
  /** Full SSE body served for stream requests. */
  sseBody?: string;
  /** Emit one chunk then keep the stream open forever. */
  sseHang?: boolean;
}

let script: StubScript = {};
let stub: ReturnType<typeof Bun.serve> | null = null;
let stubPort = 0;
let usageDir = '';
const originalEnv = { ...process.env };
const encoder = new TextEncoder();

function sseChunk(delta: Record<string, unknown>, finishReason?: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'stub-model',
    choices: [
      {
        index: 0,
        delta,
        ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
      },
    ],
  })}\n\n`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

beforeAll(() => {
  stub = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => null)) as {
        model?: string;
        stream?: boolean;
      } | null;

      if (url.pathname === '/v1/chat/completions') {
        if (body?.stream === true) {
          if (script.sseHang) {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(encoder.encode(sseChunk({ content: 'partial' })));
                  // Never closes — simulates a stalled upstream.
                },
              }),
              { headers: { 'Content-Type': 'text/event-stream' } },
            );
          }
          return new Response(script.sseBody ?? '', {
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        if (script.chatDelayMs) await sleep(script.chatDelayMs);
        return Response.json({
          id: 'stub-1',
          object: 'chat.completion',
          model: body?.model ?? 'stub-model',
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hello from stub' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      }

      if (url.pathname === '/v1/embeddings') {
        if (script.embeddingsDelayMs) await sleep(script.embeddingsDelayMs);
        return Response.json({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2] }],
          model: body?.model ?? 'stub-model',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      return new Response('nf', { status: 404 });
    },
  });
  stubPort = stub.port as number;
});

afterAll(() => {
  stub?.stop(true);
});

beforeEach(() => {
  script = {};
  usageDir = mkdtempSync(join(tmpdir(), 'embersynth-adapter-usage-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, { LLAMACTL_USAGE_DIR: usageDir });
});

afterEach(() => {
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(usageDir, { recursive: true, force: true });
});

function node(id: string, requestMs = 30_000): NodeDefinition {
  return {
    id,
    label: id,
    endpoint: `http://127.0.0.1:${stubPort}`,
    transport: 'http',
    enabled: true,
    providerType: 'openai-compatible',
    modelId: 'stub-model',
    capabilities: ['reasoning'],
    tags: [],
    priority: 0,
    auth: { type: 'bearer', token: 'sk' },
    timeout: { requestMs },
    health: { intervalMs: 30_000, timeoutMs: 1_000 },
  };
}

const chatReq: AdapterRequest = { messages: [{ role: 'user', content: 'hi' }] };

async function collect(
  gen: AsyncGenerator<string>,
  sink: string[],
): Promise<void> {
  for await (const chunk of gen) sink.push(chunk);
}

describe('openai-compat adapter — per-node timeout (A1)', () => {
  test('sendRequest rejects at node.timeout.requestMs, not after the slow upstream answers', async () => {
    script = { chatDelayMs: 2500 };
    const adapter = new OpenAICompatibleAdapter();
    const start = Date.now();
    await expect(adapter.sendRequest(node('slow-chat', 150), chatReq)).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('sendEmbeddingRequest rejects at node.timeout.requestMs', async () => {
    script = { embeddingsDelayMs: 2500 };
    const adapter = new OpenAICompatibleAdapter();
    const start = Date.now();
    await expect(
      adapter.sendEmbeddingRequest!(node('slow-embed', 150), { input: ['x'] }),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe('openai-compat adapter — caller signal (A1)', () => {
  test('caller AbortSignal aborts an in-flight sendRequest', async () => {
    script = { chatDelayMs: 2500 };
    const adapter = new OpenAICompatibleAdapter();
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 120);
    const start = Date.now();
    await expect(
      adapter.sendRequest(node('caller-chat', 30_000), chatReq, caller.signal),
    ).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test('caller AbortSignal aborts a stalled sendStreamingRequest', async () => {
    script = { sseHang: true };
    const adapter = new OpenAICompatibleAdapter();
    const caller = new AbortController();
    const got: string[] = [];
    const iter = collect(
      adapter.sendStreamingRequest!(node('caller-stream', 30_000), chatReq, caller.signal),
      got,
    );
    await sleep(150);
    caller.abort();
    await expect(iter).rejects.toThrow();
  });
});

describe('openai-compat adapter — stream termination (A3)', () => {
  test('EOF without [DONE] or finish_reason throws naming the node', async () => {
    script = { sseBody: sseChunk({ content: 'hello' }) };
    const adapter = new OpenAICompatibleAdapter();
    const got: string[] = [];
    await expect(
      collect(adapter.sendStreamingRequest!(node('eof-node'), chatReq), got),
    ).rejects.toThrow(/eof-node/);
    expect(got).toEqual(['hello']);
  });

  test('finish_reason then EOF completes and yields FINISH_REASON_MARKER', async () => {
    script = { sseBody: sseChunk({ content: 'hi' }) + sseChunk({}, 'stop') };
    const adapter = new OpenAICompatibleAdapter();
    const got: string[] = [];
    await collect(adapter.sendStreamingRequest!(node('fin-node'), chatReq), got);
    expect(got).toEqual(['hi', `${FINISH_REASON_MARKER}stop`]);
  });

  test('mid-stream SSE error frame throws and never yields FINISH_REASON_MARKER', async () => {
    script = {
      sseBody:
        sseChunk({ content: 'hi' }) +
        'data: {"error":{"message":"boom","type":"server_error"}}\n\n',
    };
    const adapter = new OpenAICompatibleAdapter();
    const got: string[] = [];
    await expect(
      collect(adapter.sendStreamingRequest!(node('err-node'), chatReq), got),
    ).rejects.toThrow(/err-node/);
    expect(got).toEqual(['hi']);
    expect(got.some((c) => c.startsWith(FINISH_REASON_MARKER))).toBe(false);
  });

  test('tool-call stream truncated mid-arguments throws', async () => {
    script = {
      sseBody: sseChunk({
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"par' },
          },
        ],
      }),
    };
    const adapter = new OpenAICompatibleAdapter();
    const got: string[] = [];
    await expect(
      collect(adapter.sendStreamingRequest!(node('toolcall-trunc'), chatReq), got),
    ).rejects.toThrow(/toolcall-trunc/);
    expect(got.length).toBe(1);
    expect(got[0]!.startsWith(TOOL_CALLS_MARKER)).toBe(true);
  });
});
