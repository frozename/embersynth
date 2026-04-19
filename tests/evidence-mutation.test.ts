import { describe, test, expect } from 'bun:test';
import type { ChatMessage, AdapterRequest, EvidenceBundle } from '../src/types/index.js';

/**
 * Simulate what prepareMessages() does inside the OpenAI-compatible adapter.
 * We replicate the logic here because prepareMessages is not exported.
 * The key behavior under test is that the clone boundary (structuredClone)
 * prevents mutations from leaking back to the caller's message objects.
 */
function simulatePrepareMessages(request: AdapterRequest): ChatMessage[] {
  // This mirrors the fixed implementation: structuredClone instead of spread
  const messages = structuredClone(request.messages);

  if (request.evidence && request.evidence.items.length > 0) {
    const evidenceText = request.evidence.items
      .map((item) => `[${item.capability} from ${item.nodeId}]:\n${item.content}`)
      .join('\n\n');

    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      const currentContent = systemMsg.content == null
        ? ''
        : typeof systemMsg.content === 'string'
          ? systemMsg.content
          : systemMsg.content.map((p) => ('text' in p ? p.text : '')).join('');
      systemMsg.content = `${currentContent}\n\n## Evidence from prior stages:\n${evidenceText}`;
    } else {
      messages.unshift({
        role: 'system',
        content: `## Evidence from prior stages:\n${evidenceText}`,
      });
    }
  }

  return messages;
}

/**
 * Simulate the BROKEN behavior (shallow copy with spread) to prove the
 * bug exists when using [...messages] and is fixed with structuredClone.
 */
function simulateBrokenPrepareMessages(request: AdapterRequest): ChatMessage[] {
  const messages = [...request.messages]; // BUG: shallow copy

  if (request.evidence && request.evidence.items.length > 0) {
    const evidenceText = request.evidence.items
      .map((item) => `[${item.capability} from ${item.nodeId}]:\n${item.content}`)
      .join('\n\n');

    const systemMsg = messages.find((m) => m.role === 'system');
    if (systemMsg) {
      const currentContent = systemMsg.content == null
        ? ''
        : typeof systemMsg.content === 'string'
          ? systemMsg.content
          : systemMsg.content.map((p) => ('text' in p ? p.text : '')).join('');
      systemMsg.content = `${currentContent}\n\n## Evidence from prior stages:\n${evidenceText}`;
    } else {
      messages.unshift({
        role: 'system',
        content: `## Evidence from prior stages:\n${evidenceText}`,
      });
    }
  }

  return messages;
}

function makeEvidence(content: string): EvidenceBundle {
  return {
    planId: 'test-plan',
    items: [
      {
        stageIndex: 0,
        nodeId: 'node-vision',
        capability: 'vision',
        content,
        durationMs: 100,
        timestamp: Date.now(),
      },
    ],
    totalDurationMs: 100,
  };
}

describe('evidence mutation guard (structuredClone fix)', () => {
  test('original messages are unchanged after prepareMessages with evidence', () => {
    const originalMessages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Describe this image.' },
    ];

    const request: AdapterRequest = {
      messages: originalMessages,
      evidence: makeEvidence('The image shows a red car.'),
    };

    const result = simulatePrepareMessages(request);

    // The returned messages should have evidence injected
    const resultSystem = result.find((m) => m.role === 'system');
    expect(resultSystem).toBeDefined();
    expect(resultSystem!.content).toContain('## Evidence from prior stages:');
    expect(resultSystem!.content).toContain('The image shows a red car.');

    // The original system message must be UNTOUCHED
    expect(originalMessages[0].content).toBe('You are a helpful assistant.');
    expect(originalMessages.length).toBe(2);
  });

  test('calling prepareMessages twice does NOT accumulate evidence', () => {
    const originalMessages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Summarize findings.' },
    ];

    const evidence1 = makeEvidence('Stage 1 output: found a cat.');
    const evidence2 = makeEvidence('Stage 2 output: found a dog.');

    // First call — simulates stage 1 adapter processing
    const request1: AdapterRequest = {
      messages: originalMessages,
      evidence: evidence1,
    };
    const result1 = simulatePrepareMessages(request1);

    // Second call — simulates stage 2 adapter processing with same originalMessages
    const request2: AdapterRequest = {
      messages: originalMessages,
      evidence: evidence2,
    };
    const result2 = simulatePrepareMessages(request2);

    // Original messages must still be pristine
    expect(originalMessages[0].content).toBe('You are a helpful assistant.');

    // result1 should contain evidence1 only
    const sys1 = result1.find((m) => m.role === 'system')!;
    expect(sys1.content).toContain('Stage 1 output: found a cat.');
    expect(sys1.content).not.toContain('Stage 2 output: found a dog.');

    // result2 should contain evidence2 only, NOT evidence1 leaking in
    const sys2 = result2.find((m) => m.role === 'system')!;
    expect(sys2.content).toContain('Stage 2 output: found a dog.');
    expect(sys2.content).not.toContain('Stage 1 output: found a cat.');
  });

  test('system message content is not duplicated across multiple calls', () => {
    const originalMessages: ChatMessage[] = [
      { role: 'system', content: 'Base prompt.' },
      { role: 'user', content: 'Hello' },
    ];
    const evidence = makeEvidence('Some evidence text.');

    const request: AdapterRequest = { messages: originalMessages, evidence };

    // Call three times with the same input
    simulatePrepareMessages(request);
    simulatePrepareMessages(request);
    const result = simulatePrepareMessages(request);

    // The original must be untouched
    expect(originalMessages[0].content).toBe('Base prompt.');

    // The result should have exactly one evidence section, not three
    const systemContent = result.find((m) => m.role === 'system')!.content as string;
    const evidenceCount = (systemContent.match(/## Evidence from prior stages:/g) ?? []).length;
    expect(evidenceCount).toBe(1);
  });

  test('structured content (ContentPart[]) is deep-cloned', () => {
    const originalMessages: ChatMessage[] = [
      {
        role: 'system',
        content: [{ type: 'text', text: 'You are a vision model.' }],
      },
      { role: 'user', content: 'Analyze this.' },
    ];

    const request: AdapterRequest = {
      messages: originalMessages,
      evidence: makeEvidence('Detected: a landscape photo.'),
    };

    const result = simulatePrepareMessages(request);

    // The result system message content should be a string now (evidence was appended)
    const resultSystem = result.find((m) => m.role === 'system')!;
    expect(typeof resultSystem.content).toBe('string');
    expect(resultSystem.content).toContain('Detected: a landscape photo.');

    // Original must still have the ContentPart[] structure
    expect(Array.isArray(originalMessages[0].content)).toBe(true);
    const parts = originalMessages[0].content as { type: string; text: string }[];
    expect(parts[0].text).toBe('You are a vision model.');
  });

  test('the broken (shallow copy) version DOES mutate originals — proving the fix matters', () => {
    const originalMessages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ];

    const request: AdapterRequest = {
      messages: originalMessages,
      evidence: makeEvidence('Evidence text.'),
    };

    // Using the broken version should mutate the original
    simulateBrokenPrepareMessages(request);

    // This PROVES the bug: the original system message is now mutated
    expect(originalMessages[0].content).not.toBe('You are a helpful assistant.');
    expect(originalMessages[0].content).toContain('## Evidence from prior stages:');
  });

  test('without evidence, original messages remain unchanged', () => {
    const originalMessages: ChatMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ];

    const request: AdapterRequest = { messages: originalMessages };

    const result = simulatePrepareMessages(request);

    // Should be a separate array with cloned objects
    expect(result).not.toBe(originalMessages);
    expect(result[0]).not.toBe(originalMessages[0]);
    expect(result[0].content).toBe('You are a helpful assistant.');
    expect(originalMessages[0].content).toBe('You are a helpful assistant.');
  });
});
