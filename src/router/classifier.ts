import type { ChatMessage, Capability, RequestClassification, ContentPart } from '../types/index.js';

// Tool-use indicating patterns
const TOOL_USE_PATTERNS = [
  /\buse\s+the\s+tool\b/i,
  /\bcall\s+the\s+function\b/i,
  /\bexecute\s+function\b/i,
];

/** Check if any message contains image content */
function hasImageContent(messages: ChatMessage[]): boolean {
  return messages.some((msg) => {
    if (msg.content == null) return false;
    if (typeof msg.content === 'string') {
      return /\.(png|jpg|jpeg|gif|webp|svg|bmp)|data:image\//i.test(msg.content);
    }
    return msg.content.some((part: ContentPart) => part.type === 'image_url');
  });
}

// Retrieval-indicating patterns
const RETRIEVAL_PATTERNS = [
  /\b(search|find|look\s*up|retrieve|fetch|query)\b.*\b(document|file|record|data|information|knowledge)\b/i,
  /\b(what|where|who|when)\b.*\b(said|wrote|documented|recorded|published)\b/i,
  /\b(according\s+to|based\s+on|from\s+the|in\s+the)\b.*\b(database|docs?|documentation|records?|files?|source)\b/i,
  /\bRAG\b/,
  /\b(context|knowledge\s*base|corpus|index)\b/i,
];

// Memory-indicating patterns
const MEMORY_PATTERNS = [
  /\b(remember|recall|previously|earlier|last\s+time|before)\b/i,
  /\b(conversation\s+history|chat\s+history|prior\s+context)\b/i,
  /\b(you\s+told\s+me|we\s+discussed|we\s+talked\s+about)\b/i,
  /\b(save|store|note|keep\s+track)\b.*\b(for\s+later|for\s+next|future)\b/i,
];

/** Extract all text content from messages */
function extractText(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.content == null) return '';
      if (typeof m.content === 'string') return m.content;
      return m.content
        .map((p: ContentPart) => ('text' in p ? p.text : ''))
        .join(' ');
    })
    .join(' ');
}

/** Check if text matches any pattern in a set */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

/** Estimate request complexity based on message length and structure */
function estimateComplexity(messages: ChatMessage[]): 'simple' | 'moderate' | 'complex' {
  const totalLength = messages.reduce((sum, m) => {
    if (m.content == null) return sum;
    const content =
      typeof m.content === 'string'
        ? m.content
        : m.content.map((p: ContentPart) => ('text' in p ? p.text : '')).join('');
    return sum + content.length;
  }, 0);

  const messageCount = messages.length;

  if (totalLength < 500 && messageCount <= 3) return 'simple';
  if (totalLength < 3000 && messageCount <= 10) return 'moderate';
  return 'complex';
}

/** Check if messages contain tool_calls or tool-use keywords */
function hasToolUseContent(messages: ChatMessage[]): boolean {
  // Check if any message has tool_calls property
  if (messages.some((msg) => msg.tool_calls && msg.tool_calls.length > 0)) {
    return true;
  }

  // Check for tool-related keywords in text
  const text = extractText(messages);
  return matchesAny(text, TOOL_USE_PATTERNS);
}

/** Classify a chat completion request to determine required capabilities and stages */
export function classifyRequest(messages: ChatMessage[]): RequestClassification {
  const requiredCapabilities: Capability[] = [];
  const stages: Capability[][] = [];

  const hasVision = hasImageContent(messages);
  const complexity = estimateComplexity(messages);
  const text = extractText(messages);
  const hasRetrievalNeed = matchesAny(text, RETRIEVAL_PATTERNS);
  const hasMemoryNeed = matchesAny(text, MEMORY_PATTERNS);
  const hasToolUse = hasToolUseContent(messages);

  // Build pipeline stages in execution order

  // Tool use detected — tools are passed through to the reasoning node
  // No separate stage needed; the adapter handles tool serialization

  // Memory stage (recall prior context)
  if (hasMemoryNeed) {
    requiredCapabilities.push('memory');
    stages.push(['memory']);
  }

  // Retrieval stage (fetch relevant documents)
  if (hasRetrievalNeed) {
    requiredCapabilities.push('retrieval');
    stages.push(['retrieval']);
  }

  // Vision stage
  if (hasVision) {
    requiredCapabilities.push('vision');
    stages.push(['vision']);
  }

  // Reasoning is always the final stage for chat completions
  requiredCapabilities.push('reasoning');
  stages.push(['reasoning']);

  return {
    requiredCapabilities,
    hasVisionContent: hasVision,
    hasEmbeddingRequest: false,
    hasRetrievalNeed,
    hasMemoryNeed,
    hasToolUse,
    estimatedComplexity: complexity,
    suggestedStages: stages,
  };
}
