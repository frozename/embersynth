import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

beforeAll(() => {
  stub = Bun.serve({
    port: STUB_PORT,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/v1/chat/completions') {
        const body = (await req.json()) as { model: string; stream?: boolean };
        if (body.stream) {
          return new Response('stream not tested here', { status: 400 });
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

describe('openai-compat adapter — usage recording (N.3.3)', () => {
  test('non-streaming chat appends a UsageRecord with route=embersynth:<node>', async () => {
    const adapter = new OpenAICompatibleAdapter();
    const req: AdapterRequest = {
      messages: [{ role: 'user', content: 'hi' }],
    };
    await adapter.sendRequest(fakeNode(), req);
    const path = await waitForUsageFile();
    expect(path).not.toBeNull();
    const [line] = readFileSync(path!, 'utf8').trim().split('\n');
    const record = JSON.parse(line!) as Record<string, unknown>;
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
    const record = JSON.parse(
      readFileSync(path!, 'utf8').trim().split('\n')[0]!,
    ) as Record<string, unknown>;
    expect(record.kind).toBe('embedding');
    expect(record.completion_tokens).toBe(0);
    // input was a single-element string array 'abc'; stub counts the
    // input's JSON-like length — exact count is adapter impl detail;
    // just assert it's numeric.
    expect(typeof record.prompt_tokens).toBe('number');
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
