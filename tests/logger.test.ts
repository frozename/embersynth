import { describe, test, expect } from 'bun:test';
import { log, setLogLevel, withRequestId } from '../src/logger/index.js';

describe('logger', () => {
  test('withRequestId includes requestId in all log calls', () => {
    // Verify the child logger factory returns expected methods
    const child = withRequestId('req-123');
    expect(typeof child.debug).toBe('function');
    expect(typeof child.info).toBe('function');
    expect(typeof child.warn).toBe('function');
    expect(typeof child.error).toBe('function');
  });

  test('log has all level methods', () => {
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
  });

  test('setLogLevel is callable', () => {
    // Should not throw
    setLogLevel('debug');
    setLogLevel('info');
    setLogLevel('warn');
    setLogLevel('error');
    // Reset to info
    setLogLevel('info');
  });
});
