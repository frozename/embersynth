import { expect, test, describe } from 'bun:test';
import { mergeToolCallDeltas, TOOL_CALLS_MARKER, type ToolCallMap } from '../src/adapters/stream-markers.js';

describe('mergeToolCallDeltas', () => {
  test('creates new tool call if index does not exist', () => {
    const map: ToolCallMap = new Map();
    const rawDelta = JSON.stringify([{ index: 0, id: 'call_123', type: 'function', function: { name: 'get_weather', arguments: '{"location":' } }]);
    
    mergeToolCallDeltas(map, rawDelta);
    
    expect(map.size).toBe(1);
    expect(map.get(0)).toEqual({
      id: 'call_123',
      type: 'function',
      function: {
        name: 'get_weather',
        arguments: '{"location":',
      },
    });
  });

  test('handles marker prefix correctly', () => {
    const map: ToolCallMap = new Map();
    const rawDelta = TOOL_CALLS_MARKER + JSON.stringify([{ index: 0, id: 'call_123', type: 'function', function: { name: 'get_weather', arguments: '{"location":' } }]);
    
    mergeToolCallDeltas(map, rawDelta);
    
    expect(map.size).toBe(1);
    expect(map.get(0)).toEqual({
      id: 'call_123',
      type: 'function',
      function: {
        name: 'get_weather',
        arguments: '{"location":',
      },
    });
  });

  test('merges arguments for existing tool call', () => {
    const map: ToolCallMap = new Map();
    const delta1 = JSON.stringify([{ index: 0, id: 'call_123', type: 'function', function: { name: 'get_weather', arguments: '{"location":' } }]);
    const delta2 = JSON.stringify([{ index: 0, function: { arguments: '"Boston"}' } }]);
    
    mergeToolCallDeltas(map, delta1);
    mergeToolCallDeltas(map, delta2);
    
    expect(map.size).toBe(1);
    expect(map.get(0)).toEqual({
      id: 'call_123',
      type: 'function',
      function: {
        name: 'get_weather',
        arguments: '{"location":"Boston"}',
      },
    });
  });

  test('handles multiple tool calls in a single delta', () => {
    const map: ToolCallMap = new Map();
    const delta = JSON.stringify([
      { index: 0, id: 'call_1', type: 'function', function: { name: 'func1', arguments: 'arg1' } },
      { index: 1, id: 'call_2', type: 'function', function: { name: 'func2', arguments: 'arg2' } }
    ]);
    
    mergeToolCallDeltas(map, delta);
    
    expect(map.size).toBe(2);
    expect(map.get(0)?.id).toBe('call_1');
    expect(map.get(1)?.id).toBe('call_2');
  });
});
