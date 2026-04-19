import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Append-only JSONL sink for routing decisions. One line per call to
 * `appendEvidence(...)` — the MCP `embersynth.evidence.tail` tool reads
 * the last N entries for operator debugging. This complements
 * `src/evidence/compressor.ts` (per-plan evidence-bundle compression);
 * this file is the *operator-facing* decision log, not the in-flight
 * evidence that feeds synthesis.
 *
 * Storage shape:
 *   $EMBERSYNTH_EVIDENCE_PATH  (full file path override; tests use this)
 *   ~/.embersynth/evidence.jsonl  (default)
 *
 * Each record:
 *   { ts, request, winner, candidates }
 * where `winner` is `{ nodeId }` and `candidates` is
 * `[{ nodeId, score, reasons }]`.
 */

export interface EvidenceRecord {
  ts: string;
  request: unknown;
  winner: { nodeId: string } | null;
  candidates: Array<{ nodeId: string; score: number; reasons: string[] }>;
}

export interface AppendEvidenceOptions {
  request: unknown;
  winner: { nodeId: string } | null;
  candidates: Array<{ nodeId: string; score: number; reasons: string[] }>;
  /** Override the sink path (tests pass this via env). */
  path?: string;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

export function defaultEvidencePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.EMBERSYNTH_EVIDENCE_PATH?.trim();
  if (override) return override;
  return join(homedir(), '.embersynth', 'evidence.jsonl');
}

export function appendEvidence(opts: AppendEvidenceOptions): EvidenceRecord {
  const now = (opts.now ?? (() => new Date()))();
  const path = opts.path ?? defaultEvidencePath();
  const record: EvidenceRecord = {
    ts: now.toISOString(),
    request: opts.request,
    winner: opts.winner,
    candidates: opts.candidates,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    // Evidence logging is best-effort — never break a running router.
    process.stderr.write(
      `embersynth evidence: append failed: ${(err as Error).message}\n`,
    );
  }
  return record;
}

export interface TailOptions {
  limit?: number;
  path?: string;
}

export function tailEvidence(opts: TailOptions = {}): EvidenceRecord[] {
  const path = opts.path ?? defaultEvidencePath();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 10_000));
  if (!existsSync(path)) return [];
  const body = readFileSync(path, 'utf8');
  const lines = body.split('\n').filter((l) => l.trim().length > 0);
  const slice = lines.slice(-limit);
  const out: EvidenceRecord[] = [];
  for (const line of slice) {
    try {
      out.push(JSON.parse(line) as EvidenceRecord);
    } catch {
      // Skip malformed lines rather than bail — evidence is best-effort.
    }
  }
  return out;
}
