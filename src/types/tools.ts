export interface ToolDefinition {
  name: string;
  description: string;
  parameters?: Record<string, unknown>; // JSON Schema
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ToolResult {
  toolCallId: string;
  content: string;
}

/** Partial tool_call delta as received during streaming */
export interface ToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}
