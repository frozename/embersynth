import type { EvidenceBundle, EvidenceItem, RoutingPolicy } from '../types/index.js';

const DEFAULT_MAX_LENGTH = 4000;

/** Truncate a single evidence item's content to fit within limits */
function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) return content;

  // Keep beginning and end, mark truncation
  const keepEach = Math.floor((maxLength - 40) / 2);
  return (
    content.slice(0, keepEach) +
    '\n\n[... truncated ...]\n\n' +
    content.slice(-keepEach)
  );
}

/** Extract key sentences from content using simple heuristics */
function extractKeySentences(content: string, maxLength: number): string {
  const sentences = content
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.trim().length > 10);

  if (sentences.length === 0) return truncateContent(content, maxLength);

  const result: string[] = [];
  let totalLength = 0;

  // Prioritize first and last sentences (usually most informative)
  const priority = [
    ...sentences.slice(0, 3),
    ...sentences.slice(-2),
    ...sentences.slice(3, -2),
  ];

  const seen = new Set<string>();
  for (const sentence of priority) {
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    if (totalLength + sentence.length > maxLength) break;
    result.push(sentence);
    totalLength += sentence.length + 1;
  }

  return result.join(' ');
}

/** Compress an evidence bundle to reduce token usage in synthesis */
export function compressEvidence(
  bundle: EvidenceBundle,
  policy: RoutingPolicy,
): EvidenceBundle {
  if (!policy.evidenceCompression) return bundle;

  const maxLength = policy.evidenceMaxLength ?? DEFAULT_MAX_LENGTH;

  const compressedItems: EvidenceItem[] = bundle.items.map((item) => {
    if (item.content.length <= maxLength) return item;

    return {
      ...item,
      content: extractKeySentences(item.content, maxLength),
      metadata: {
        ...item.metadata,
        compressed: true,
        originalLength: item.content.length,
      },
    };
  });

  return {
    ...bundle,
    items: compressedItems,
  };
}
