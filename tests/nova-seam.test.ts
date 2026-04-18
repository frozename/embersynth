import { describe, expect, test } from 'bun:test';
import {
  UnifiedAiRequestSchema,
  ChatMessageSchema,
  createOpenAICompatProvider,
  type ChatMessage as NovaChatMessage,
} from '@nova/contracts';
import type { ChatMessage as EmbersynthChatMessage } from '../src/types/index.js';

/**
 * Seam test — proves embersynth can resolve and import from the
 * standalone @nova/contracts repo. Guards against a regression where
 * the file: dep breaks or schemas diverge between consumers.
 *
 * Migration plan (follow-ups):
 *   * Replace embersynth's local ChatMessage/ChatCompletionRequest
 *     with Nova equivalents, module by module.
 *   * Swap the adapter layer to use createOpenAICompatProvider instead
 *     of the local src/adapters/openai-compatible.ts.
 *   * Drop the duplicated local types once no code imports them.
 */

describe('nova-seam: @nova/contracts import works from embersynth', () => {
  test('UnifiedAiRequestSchema parses a minimal request', () => {
    const req = UnifiedAiRequestSchema.parse({
      model: 'local',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.messages[0]!.content).toBe('hi');
  });

  test('ChatMessageSchema round-trips', () => {
    const msg = ChatMessageSchema.parse({ role: 'assistant', content: 'ok' });
    expect(msg.role).toBe('assistant');
  });

  test('createOpenAICompatProvider is callable', () => {
    const p = createOpenAICompatProvider({
      name: 'nova-seam',
      baseUrl: 'http://127.0.0.1:9999/v1',
      apiKey: 'none',
    });
    expect(p.name).toBe('nova-seam');
  });

  test('embersynth ChatMessage IS Nova ChatMessage (alias identity)', () => {
    // Compile-time assertion: if embersynth's ChatMessage ever drifts
    // from Nova's, this assignment fails typecheck. The runtime check
    // is a tautology that keeps the test suite honest about the intent.
    const msg: EmbersynthChatMessage = { role: 'user', content: 'hi' };
    const also: NovaChatMessage = msg;
    expect(also.role).toBe('user');
  });
});
