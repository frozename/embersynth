import { describe, test, expect } from 'bun:test';
import { classifyRequest } from '../src/router/classifier.js';
import type { ChatMessage } from '../src/types/index.js';
import type { ToolDefinition, ToolCall, ToolResult } from '../src/types/tools.js';

describe('tool execution support', () => {
  test('classifier detects tool_calls in messages', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'get_weather',
              arguments: '{"location": "San Francisco"}',
            },
          },
        ],
      },
    ];

    const result = classifyRequest(messages);
    expect(result.hasToolUse).toBe(true);
  });

  test('classifier detects tool-use keywords', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Please use the tool to search for weather data' },
    ];

    const result = classifyRequest(messages);
    expect(result.hasToolUse).toBe(true);
  });

  test('classifier detects tools but does not add tool-execution capability', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Call the function to get the current time' },
    ];

    const result = classifyRequest(messages);
    expect(result.hasToolUse).toBe(true);
    expect(result.requiredCapabilities).not.toContain('tool-execution');
  });

  test('classifier does not detect tools in normal text', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'Hello world' },
    ];

    const result = classifyRequest(messages);
    expect(result.hasToolUse).toBe(false);
    expect(result.requiredCapabilities).not.toContain('tool-execution');
  });

  test('tool types are properly defined', () => {
    // Verify ToolDefinition structure
    const toolDef: ToolDefinition = {
      name: 'get_weather',
      description: 'Get the current weather',
      parameters: {
        type: 'object',
        properties: {
          location: { type: 'string', description: 'City name' },
        },
        required: ['location'],
      },
    };
    expect(toolDef.name).toBe('get_weather');
    expect(toolDef.description).toBe('Get the current weather');
    expect(toolDef.parameters).toBeDefined();

    // Verify ToolCall structure
    const toolCall: ToolCall = {
      id: 'call_abc123',
      type: 'function',
      function: {
        name: 'get_weather',
        arguments: '{"location": "London"}',
      },
    };
    expect(toolCall.id).toBe('call_abc123');
    expect(toolCall.type).toBe('function');
    expect(toolCall.function.name).toBe('get_weather');
    expect(toolCall.function.arguments).toBe('{"location": "London"}');

    // Verify ToolResult structure
    const toolResult: ToolResult = {
      toolCallId: 'call_abc123',
      content: '{"temperature": 15, "unit": "celsius"}',
    };
    expect(toolResult.toolCallId).toBe('call_abc123');
    expect(toolResult.content).toBeDefined();
  });
});
