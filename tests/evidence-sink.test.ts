import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendEvidence, defaultEvidencePath, tailEvidence } from '../src/evidence/index.js';
import type { EvidenceRecord } from '../src/evidence/index.js';

// #22: pin the sink path resolution, the append behaviour and the tail
// clamping of src/evidence/index.ts. Every call passes an explicit path,
// so neither EMBERSYNTH_EVIDENCE_PATH nor ~/.embersynth is read or written.

const FIXED_TS = '2026-01-02T03:04:05.000Z';
const fixedNow = (): Date => new Date(FIXED_TS);

let tempDir = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'es-evidence-22-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

/** A record whose `request` is its index, so tail results can be compared by index. */
function seedRecord(index: number): EvidenceRecord {
  return { ts: FIXED_TS, request: index, winner: { nodeId: `n${index}` }, candidates: [] };
}

/** Write `body` to <tempDir>/evidence.jsonl and return the path. */
function writeSink(body: string): string {
  const sinkPath = join(tempDir, 'evidence.jsonl');
  writeFileSync(sinkPath, body);
  return sinkPath;
}

/** Write `count` records (request 0 .. count-1), one JSON line each, and return the path. */
function seedSink(count: number): string {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) lines.push(JSON.stringify(seedRecord(i)));
  return writeSink(`${lines.join('\n')}\n`);
}

/** The `request` field of each record, i.e. the seed index. */
function requests(records: EvidenceRecord[]): unknown[] {
  return records.map((r) => r.request);
}

describe('evidence sink: defaultEvidencePath (#22)', () => {
  test('a set EMBERSYNTH_EVIDENCE_PATH is trimmed and wins', () => {
    expect(defaultEvidencePath({ EMBERSYNTH_EVIDENCE_PATH: '  /x/e.jsonl  ' })).toBe('/x/e.jsonl');
  });

  test('an empty, whitespace-only or missing override uses ~/.embersynth/evidence.jsonl', () => {
    const fallbackPath = join(homedir(), '.embersynth', 'evidence.jsonl');
    expect(defaultEvidencePath({ EMBERSYNTH_EVIDENCE_PATH: '   ' })).toBe(fallbackPath);
    expect(defaultEvidencePath({ EMBERSYNTH_EVIDENCE_PATH: '' })).toBe(fallbackPath);
    expect(defaultEvidencePath({})).toBe(fallbackPath);
  });
});

describe('evidence sink: appendEvidence (#22)', () => {
  test('returns the record stamped by the injected clock and creates missing parent dirs', () => {
    const sinkPath = join(tempDir, 'a', 'b', 'e.jsonl');
    const record = appendEvidence({
      request: { model: 'fusion-auto' },
      winner: { nodeId: 'n1' },
      candidates: [{ nodeId: 'n1', score: 0.9, reasons: ['healthy'] }],
      path: sinkPath,
      now: fixedNow,
    });
    expect(record).toEqual({
      ts: FIXED_TS,
      request: { model: 'fusion-auto' },
      winner: { nodeId: 'n1' },
      candidates: [{ nodeId: 'n1', score: 0.9, reasons: ['healthy'] }],
    });
    expect(readFileSync(sinkPath, 'utf8')).toBe(`${JSON.stringify(record)}\n`);
  });

  test('each call appends exactly one JSON line and keeps a null winner', () => {
    const sinkPath = join(tempDir, 'e.jsonl');
    const first = appendEvidence({
      request: 'first',
      winner: { nodeId: 'n1' },
      candidates: [],
      path: sinkPath,
      now: fixedNow,
    });
    const second = appendEvidence({ request: 'second', winner: null, candidates: [], path: sinkPath, now: fixedNow });
    expect(second.winner).toBeNull();
    const lines = readFileSync(sinkPath, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[0]) as unknown).toEqual(first);
    expect(JSON.parse(lines[1]) as unknown).toEqual({ ts: FIXED_TS, request: 'second', winner: null, candidates: [] });
  });

  test('a failed append does not throw, still returns the record and writes one stderr line', () => {
    const stderrLines: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    let record: EvidenceRecord | undefined;
    try {
      // tempDir is an existing directory, so appending to it as a file fails.
      expect(() => {
        record = appendEvidence({ request: 'r', winner: null, candidates: [], path: tempDir, now: fixedNow });
      }).not.toThrow();
    } finally {
      process.stderr.write = originalWrite;
    }
    expect(record).toEqual({ ts: FIXED_TS, request: 'r', winner: null, candidates: [] });
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0].startsWith('embersynth evidence: append failed: ')).toBe(true);
    expect(stderrLines[0].endsWith('\n')).toBe(true);
  });
});

describe('evidence sink: tailEvidence (#22)', () => {
  test('a missing file returns an empty list', () => {
    expect(tailEvidence({ path: join(tempDir, 'missing.jsonl') })).toEqual([]);
  });

  test('without a limit it returns the last 50 records in file order', () => {
    const records = tailEvidence({ path: seedSink(60) });
    expect(records).toHaveLength(50);
    expect(records[0].request).toBe(10);
    expect(records[49].request).toBe(59);
  });

  test('limit 0 and a negative limit are clamped to 1', () => {
    const sinkPath = seedSink(5);
    expect(requests(tailEvidence({ path: sinkPath, limit: 0 }))).toEqual([4]);
    expect(requests(tailEvidence({ path: sinkPath, limit: -5 }))).toEqual([4]);
  });

  test('a limit above 10000 is capped at 10000', () => {
    const records = tailEvidence({ path: seedSink(10_001), limit: 20_000 });
    expect(records).toHaveLength(10_000);
    expect(records[0].request).toBe(1);
    expect(records[9_999].request).toBe(10_000);
  });

  test('blank and whitespace-only lines are ignored and do not count toward the limit', () => {
    const r0 = JSON.stringify(seedRecord(0));
    const r1 = JSON.stringify(seedRecord(1));
    const sinkPath = writeSink(`${r0}\n\n   \n${r1}\n\t\n`);
    expect(requests(tailEvidence({ path: sinkPath, limit: 2 }))).toEqual([0, 1]);
  });

  test('a malformed line is skipped while its neighbours parse', () => {
    const r0 = JSON.stringify(seedRecord(0));
    const r1 = JSON.stringify(seedRecord(1));
    const sinkPath = writeSink(`${r0}\nnot-json\n${r1}\n`);
    expect(requests(tailEvidence({ path: sinkPath, limit: 10 }))).toEqual([0, 1]);
  });

  test('the limit is applied before parsing, so a malformed last line costs a record', () => {
    const r0 = JSON.stringify(seedRecord(0));
    const r1 = JSON.stringify(seedRecord(1));
    const sinkPath = writeSink(`${r0}\n${r1}\nnot-json\n`);
    expect(requests(tailEvidence({ path: sinkPath, limit: 2 }))).toEqual([1]);
  });
});
