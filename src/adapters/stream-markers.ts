export const TOOL_CALLS_MARKER = '\0tool_calls:' as const;
export const FINISH_REASON_MARKER = '\0finish_reason:' as const;

export type ToolCallMap = Map<number, { id: string; type: 'function'; function: { name: string; arguments: string } }>;

export function mergeToolCallDeltas(map: ToolCallMap, rawDelta: string): void {
  const jsonStr = rawDelta.startsWith(TOOL_CALLS_MARKER)
    ? rawDelta.slice(TOOL_CALLS_MARKER.length)
    : rawDelta;

  const deltas = JSON.parse(jsonStr) as Array<{
    index: number; id?: string; type?: string;
    function?: { name?: string; arguments?: string };
  }>;

  for (const d of deltas) {
    const existing = map.get(d.index);
    if (existing) {
      if (d.id) existing.id = d.id;
      if (d.type) existing.type = d.type as 'function';
      if (d.function?.name) existing.function.name = d.function.name;
      if (d.function?.arguments) existing.function.arguments += d.function.arguments;
    } else {
      map.set(d.index, {
        id: d.id ?? '',
        type: (d.type as 'function') ?? 'function',
        function: {
          name: d.function?.name ?? '',
          arguments: d.function?.arguments ?? '',
        },
      });
    }
  }
}

