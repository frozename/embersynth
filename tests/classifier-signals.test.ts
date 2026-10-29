import { describe, test, expect } from 'bun:test';
import { classifyRequest } from '../src/router/classifier.js';
import type { Capability, ChatMessage, RequestClassification } from '../src/types/index.js';

function shortMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (): ChatMessage => ({ role: 'user', content: 'Hi' }));
}

function oneMessage(content: string): ChatMessage[] {
  return [{ role: 'user', content }];
}

function expectStages(result: RequestClassification, stages: Capability[][]): void {
  expect(result.suggestedStages).toEqual(stages);
  expect(result.requiredCapabilities).toEqual(stages.map((stage) => stage[0]));
  expect(result.hasEmbeddingRequest).toBe(false);
}

describe('classifyRequest complexity thresholds (#22)', () => {
  test('three short messages are simple', () => {
    expect(classifyRequest(shortMessages(3)).estimatedComplexity).toBe('simple');
  });

  test('four short messages are moderate', () => {
    expect(classifyRequest(shortMessages(4)).estimatedComplexity).toBe('moderate');
  });

  test('ten short messages are moderate', () => {
    expect(classifyRequest(shortMessages(10)).estimatedComplexity).toBe('moderate');
  });

  test('eleven short messages are complex', () => {
    expect(classifyRequest(shortMessages(11)).estimatedComplexity).toBe('complex');
  });

  test('a 499-character message is simple', () => {
    expect(classifyRequest(oneMessage('x'.repeat(499))).estimatedComplexity).toBe('simple');
  });

  test('a 500-character message is moderate', () => {
    expect(classifyRequest(oneMessage('x'.repeat(500))).estimatedComplexity).toBe('moderate');
  });

  test('a 2999-character message is moderate', () => {
    expect(classifyRequest(oneMessage('x'.repeat(2999))).estimatedComplexity).toBe('moderate');
  });

  test('a 3000-character message is complex', () => {
    expect(classifyRequest(oneMessage('x'.repeat(3000))).estimatedComplexity).toBe('complex');
  });
});

describe('classifyRequest array and null content (#22)', () => {
  test('only text parts count toward length', () => {
    // The 624-character URL would push the total past 500 if image parts were counted.
    const imageUrl = 'https://example.com/' + 'a'.repeat(600) + '.png';
    const result = classifyRequest([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'x'.repeat(499) },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ]);
    expect(result.estimatedComplexity).toBe('simple');
    expect(result.hasVisionContent).toBe(true);
    expectStages(result, [['vision'], ['reasoning']]);
  });

  test('text parts feed the memory patterns', () => {
    const result = classifyRequest([
      { role: 'user', content: [{ type: 'text', text: 'Please remember my name' }] },
    ]);
    expect(result.hasMemoryNeed).toBe(true);
    expect(result.hasRetrievalNeed).toBe(false);
    expectStages(result, [['memory'], ['reasoning']]);
  });

  test('a null-content assistant message is skipped', () => {
    const result = classifyRequest([
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: null },
    ]);
    expect(result.hasVisionContent).toBe(false);
    expect(result.hasToolUse).toBe(false);
    expect(result.estimatedComplexity).toBe('simple');
    expectStages(result, [['reasoning']]);
  });
});

describe('classifyRequest tool-use and vision signals (#22)', () => {
  test('an empty tool_calls array is not tool use', () => {
    const result = classifyRequest([{ role: 'assistant', content: 'Done', tool_calls: [] }]);
    expect(result.hasToolUse).toBe(false);
    expectStages(result, [['reasoning']]);
  });

  test('the execute function keyword is tool use and adds no stage', () => {
    const result = classifyRequest(oneMessage('Please execute function now'));
    expect(result.hasToolUse).toBe(true);
    expectStages(result, [['reasoning']]);
  });

  test('a data:image URL in string content is vision', () => {
    const result = classifyRequest(oneMessage('Describe data:image/png;base64,AAA'));
    expect(result.hasVisionContent).toBe(true);
    expectStages(result, [['vision'], ['reasoning']]);
  });

  test('an uppercase file extension is vision', () => {
    const result = classifyRequest(oneMessage('See PHOTO.JPG'));
    expect(result.hasVisionContent).toBe(true);
    expectStages(result, [['vision'], ['reasoning']]);
  });

  test('an extension word without a dot is not vision', () => {
    const result = classifyRequest(oneMessage('Send me a png file'));
    expect(result.hasVisionContent).toBe(false);
    expectStages(result, [['reasoning']]);
  });
});
