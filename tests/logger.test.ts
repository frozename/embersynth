import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import type { Mock } from 'bun:test';
import { log, setLogLevel, withRequestId } from '../src/logger/index.js';
import type { LogLevel } from '../src/logger/index.js';

// #22: pin src/logger/index.ts: the level filter (including the equal-level boundary),
// the console each level writes to, the JSON entry shape, the unserializable-data
// fallback and the withRequestId child logger. currentLevel is module state shared by
// every test file in the bun process, so afterEach always puts it back to 'info'.

type ConsoleName = 'log' | 'warn' | 'error';

const ALL_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

let logSpy: Mock<typeof console.log>;
let warnSpy: Mock<typeof console.warn>;
let errorSpy: Mock<typeof console.error>;

beforeEach(() => {
  setLogLevel('info');
  logSpy = spyOn(console, 'log').mockImplementation(() => {});
  warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  setLogLevel('info');
});

function clearSpies(): void {
  logSpy.mockClear();
  warnSpy.mockClear();
  errorSpy.mockClear();
}

function spyFor(name: ConsoleName): Mock<typeof console.log> {
  if (name === 'warn') return warnSpy;
  if (name === 'error') return errorSpy;
  return logSpy;
}

function consolesWritten(): ConsoleName[] {
  const names: ConsoleName[] = ['log', 'warn', 'error'];
  return names.filter((name) => spyFor(name).mock.calls.length > 0);
}

function linesOn(name: ConsoleName): string[] {
  return spyFor(name).mock.calls.map((call) => String(call[0]));
}

function onlyEntryOn(name: ConsoleName): Record<string, unknown> {
  expect(consolesWritten()).toEqual([name]);
  const lines = linesOn(name);
  expect(lines).toHaveLength(1);
  const entry: Record<string, unknown> = JSON.parse(lines[0]);
  return entry;
}

function emittedLevelsAt(threshold: LogLevel): LogLevel[] {
  setLogLevel(threshold);
  const emitted: LogLevel[] = [];
  for (const level of ALL_LEVELS) {
    clearSpies();
    log[level](`probe-${level}`);
    if (consolesWritten().length > 0) emitted.push(level);
  }
  return emitted;
}

function expectIsoTs(entry: Record<string, unknown>): void {
  const ts = entry.ts;
  expect(typeof ts).toBe('string');
  if (typeof ts !== 'string') throw new Error('ts is not a string');
  expect(new Date(ts).toISOString()).toBe(ts);
}

describe('logger level filter', () => {
  test('the default level info drops debug and emits info, warn and error', () => {
    expect(emittedLevelsAt('info')).toEqual(['info', 'warn', 'error']);
  });

  test('a level emits when it is at or above the threshold', () => {
    expect(emittedLevelsAt('debug')).toEqual(['debug', 'info', 'warn', 'error']);
    expect(emittedLevelsAt('warn')).toEqual(['warn', 'error']);
    expect(emittedLevelsAt('error')).toEqual(['error']);
  });
});

describe('logger console routing', () => {
  test('debug and info write to console.log, warn to console.warn, error to console.error', () => {
    setLogLevel('debug');
    const routes: Record<LogLevel, ConsoleName[]> = { debug: [], info: [], warn: [], error: [] };
    for (const level of ALL_LEVELS) {
      clearSpies();
      log[level](`route-${level}`);
      routes[level] = consolesWritten();
    }
    expect(routes).toEqual({ debug: ['log'], info: ['log'], warn: ['warn'], error: ['error'] });
  });

  test('each call writes exactly one string argument', () => {
    log.error('one-line', { nodeId: 'n1' });
    expect(errorSpy.mock.calls).toHaveLength(1);
    expect(errorSpy.mock.calls[0]).toHaveLength(1);
    expect(typeof errorSpy.mock.calls[0][0]).toBe('string');
  });
});

describe('logger entry shape', () => {
  test('an entry is level, ts and msg followed by the data fields at top level', () => {
    log.info('hello', { nodeId: 'n1', attempt: 2 });
    const entry = onlyEntryOn('log');
    expect(Object.keys(entry)).toEqual(['level', 'ts', 'msg', 'nodeId', 'attempt']);
    expect(entry.level).toBe('info');
    expect(entry.msg).toBe('hello');
    expect(entry.nodeId).toBe('n1');
    expect(entry.attempt).toBe(2);
    expectIsoTs(entry);
  });

  test('an entry without data has only level, ts and msg', () => {
    log.warn('bare');
    const entry = onlyEntryOn('warn');
    expect(Object.keys(entry)).toEqual(['level', 'ts', 'msg']);
    expect(entry.level).toBe('warn');
    expect(entry.msg).toBe('bare');
    expectIsoTs(entry);
  });
});

describe('logger unserializable fallback', () => {
  test('a bigint in data is replaced by the fallback entry', () => {
    log.info('boom', { big: 1n });
    const entry = onlyEntryOn('log');
    expectIsoTs(entry);
    const masked: Record<string, unknown> = { ...entry, ts: 'any-ts' };
    expect(masked).toEqual({
      level: 'info',
      ts: 'any-ts',
      msg: 'boom',
      error: 'unserializable log data',
    });
  });

  test('a circular warn entry falls back on console.warn and keeps its level', () => {
    const loop: Record<string, unknown> = { name: 'loop' };
    loop.self = loop;
    log.warn('cycle', { loop });
    const entry = onlyEntryOn('warn');
    expectIsoTs(entry);
    const masked: Record<string, unknown> = { ...entry, ts: 'any-ts' };
    expect(masked).toEqual({
      level: 'warn',
      ts: 'any-ts',
      msg: 'cycle',
      error: 'unserializable log data',
    });
  });
});

describe('withRequestId', () => {
  test('the child requestId wins over a requestId in data', () => {
    withRequestId('req-123').warn('w', { requestId: 'other', k: 1 });
    const entry = onlyEntryOn('warn');
    expect(entry.requestId).toBe('req-123');
    expect(entry.k).toBe(1);
    expect(entry.level).toBe('warn');
    expect(entry.msg).toBe('w');
  });

  test('a child call without data still carries the requestId', () => {
    withRequestId('req-9').info('i');
    const entry = onlyEntryOn('log');
    expect(Object.keys(entry)).toEqual(['level', 'ts', 'msg', 'requestId']);
    expect(entry.requestId).toBe('req-9');
  });

  test('the child logger respects the level filter and the console routing', () => {
    const child = withRequestId('r');
    child.debug('hidden');
    expect(consolesWritten()).toEqual([]);

    setLogLevel('debug');
    const routes: Record<LogLevel, ConsoleName[]> = { debug: [], info: [], warn: [], error: [] };
    const ids: unknown[] = [];
    for (const level of ALL_LEVELS) {
      clearSpies();
      child[level](`child-${level}`);
      routes[level] = consolesWritten();
      const lines = routes[level].flatMap((name) => linesOn(name));
      for (const line of lines) {
        const entry: Record<string, unknown> = JSON.parse(line);
        ids.push(entry.requestId);
      }
    }
    expect(routes).toEqual({ debug: ['log'], info: ['log'], warn: ['warn'], error: ['error'] });
    expect(ids).toEqual(['r', 'r', 'r', 'r']);
  });
});
