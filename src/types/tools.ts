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
