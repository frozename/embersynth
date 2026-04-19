import { describe, test, expect, afterAll } from 'bun:test';
import { createTestHarness } from './mock-server.js';
import type { TestHarness } from './mock-server.js';

// ── Harness lifecycle ──

let harness: TestHarness;

afterAll(() => {
  harness?.stop();
});

describe('multi-stage pipeline integration', () => {
  test('vision request builds 2-stage pipeline', async () => {
    harness = createTestHarness([
      {
        id: 'vision-node',
        capabilities: ['vision'],
        options: { response: 'I see a cat in the image', modelId: 'vision-model' },
      },
      {
        id: 'reasoning-node',
        capabilities: ['reasoning'],
        options: { response: 'Based on the analysis, the image shows a cat', modelId: 'reasoning-model' },
      },
    ]);

    const res = await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);

    // Verify 2-stage pipeline via header
    const stages = res.headers.get('X-EmberSynth-Stages');
    expect(stages).toBe('2');

    const profile = res.headers.get('X-EmberSynth-Profile');
    expect(profile).toBe('auto');

    const planId = res.headers.get('X-EmberSynth-Plan-Id');
    expect(planId).toBeTruthy();

    // The final response should come from the reasoning node
    const body = (await res.json()) as Record<string, any>;
    expect(body.choices[0].message.content).toBe('Based on the analysis, the image shows a cat');

    harness.stop();
  });

  test('intermediate stage receives vision system prompt', async () => {
    harness = createTestHarness([
      {
        id: 'vision-intermediate',
        capabilities: ['vision'],
        options: { response: 'Detailed visual description of the image contents' },
      },
      {
        id: 'reasoning-final',
        capabilities: ['reasoning'],
        options: { response: 'Synthesized answer' },
      },
    ]);

    await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this photo' },
              { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } },
            ],
          },
        ],
      }),
    });

    // Inspect the vision node's request log
    const visionNode = harness.mockNodes[0];
    const visionReqs = visionNode.requestLog.filter((r) => r.path === '/v1/chat/completions');
    expect(visionReqs.length).toBeGreaterThanOrEqual(1);

    const visionBody = visionReqs[0].body as {
      messages: { role: string; content: string | unknown[] }[];
    };

    // The vision intermediate stage should have received a system prompt override
    // about being a vision analysis stage in a multi-step pipeline
    const systemMsg = visionBody.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(typeof systemMsg!.content).toBe('string');
    expect((systemMsg!.content as string).toLowerCase()).toContain('vision');
    expect((systemMsg!.content as string).toLowerCase()).toContain('pipeline');

    harness.stop();
  });

  test('final stage receives evidence in system message', async () => {
    harness = createTestHarness([
      {
        id: 'vision-evidence',
        capabilities: ['vision'],
        options: { response: 'The image contains a landscape with mountains and a lake' },
      },
      {
        id: 'reasoning-synthesis',
        capabilities: ['reasoning'],
        options: { response: 'Final synthesized answer about the landscape' },
      },
    ]);

    await fetch(`${harness.embersynth.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'fusion-auto',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What do you see here?' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
            ],
          },
        ],
      }),
    });

    // Inspect the reasoning (final) node's request log
    const reasoningNode = harness.mockNodes[1];
    const reasoningReqs = reasoningNode.requestLog.filter((r) => r.path === '/v1/chat/completions');
    expect(reasoningReqs.length).toBeGreaterThanOrEqual(1);

    const reasoningBody = reasoningReqs[0].body as {
      messages: { role: string; content: string | unknown[] }[];
    };

    // The final stage should receive evidence from the prior vision stage
    // injected into a system message
    const systemMsg = reasoningBody.messages.find((m) => m.role === 'system');
    expect(systemMsg).toBeDefined();
    expect(typeof systemMsg!.content).toBe('string');
    expect((systemMsg!.content as string)).toContain('Evidence from prior stages');

    // The evidence should contain the vision node's output
    expect((systemMsg!.content as string)).toContain('landscape');

    harness.stop();
  });
});
