import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, createTestHarnessWithTags } from './mock-server.js';
import type { TestHarness } from './mock-server.js';

/**
 * P0.2 streaming-terminal contract — a truncated upstream stream
 * must never surface to the client as a completed response:
 *   - no `data: [DONE]`, no finish_reason 'stop' chunk
 *   - truncation before the first content falls back to the next
 *     streaming candidate
 *   - /v1/responses emits no response.completed over a truncating node
 */

let harness: TestHarness;
let usageDir = '';
const originalEnv = { ...process.env };

beforeEach(() => {
  usageDir = mkdtempSync(join(tmpdir(), 'embersynth-stream-usage-'));
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv, { LLAMACTL_USAGE_DIR: usageDir });
});

afterEach(() => {
  harness?.stop();
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, originalEnv);
  rmSync(usageDir, { recursive: true, force: true });
});

function sseChunk(delta: Record<string, unknown>, finishReason?: string | null): string {
  return `data: ${JSON.stringify({
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        delta,
        ...(finishReason !== undefined ? { finish_reason: finishReason } : {}),
      },
    ],
  })}\n\n`;
}

/** Content arrives, then the transport dies without [DONE] or finish_reason. */
const TRUNCATE_AFTER_FIRST = sseChunk({ content: 'Hello' }) + sseChunk({ content: ' trunc' });

/** Healthy terminal stream: content, finish_reason, [DONE]. */
const HEALTHY_STREAM =
  sseChunk({ role: 'assistant' }) +
  sseChunk({ content: 'Fallback streamed' }) +
  sseChunk({}, 'stop') +
  'data: [DONE]\n\n';

/**
 * Read an SSE response body to natural end OR stream error — a
 * truncated upstream surfaces as a body-level failure; we keep
 * whatever bytes arrived before it.
 */
async function readSseBody(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // stream errored mid-body — expected for truncation cases
  }
  return text;
}

describe('streaming terminal honesty', () => {
  test('truncating node emits no data: [DONE] and no finish_reason stop chunk', async () => {
    harness = createTestHarness([
      {
        id: 'trunc-mid',
        capabilities: ['reasoning'],
        options: { streamScript: TRUNCATE_AFTER_FIRST },
      },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await readSseBody(res);
    expect(body).toContain('Hello');
    expect(body).not.toContain('data: [DONE]');
    expect(body).not.toContain('"finish_reason":"stop"');
  });

  test('truncation before first content falls back to the next streaming candidate', async () => {
    harness = createTestHarnessWithTags([
      {
        id: 'trunc-first',
        capabilities: ['reasoning'],
        tags: ['local'],
        priority: 1,
        // Dies at EOF before yielding any content — the executor's
        // first-chunk probe rejects and moves to the next candidate.
        options: { streamScript: '' },
      },
      {
        id: 'stream-backup',
        capabilities: ['reasoning'],
        tags: ['local'],
        priority: 50,
        options: { streamScript: HEALTHY_STREAM },
      },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await readSseBody(res);
    expect(body).toContain('Fallback streamed');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('data: [DONE]');

    // Both nodes were contacted: primary truncated, backup served.
    const primaryReqs = harness.mockNodes[0]!.requestLog.filter(
      (r) => r.path === '/v1/chat/completions',
    );
    const backupReqs = harness.mockNodes[1]!.requestLog.filter(
      (r) => r.path === '/v1/chat/completions',
    );
    expect(primaryReqs.length).toBeGreaterThanOrEqual(1);
    expect(backupReqs.length).toBeGreaterThanOrEqual(1);
  });

  test('/v1/responses over a truncating node emits no response.completed', async () => {
    harness = createTestHarness([
      {
        id: 'trunc-resp',
        capabilities: ['reasoning'],
        options: { streamScript: TRUNCATE_AFTER_FIRST },
      },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        input: 'hi',
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await readSseBody(res);
    expect(body).toContain('response.created');
    expect(body).not.toContain('response.completed');
  });
});
