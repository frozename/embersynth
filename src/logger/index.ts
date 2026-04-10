export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface LogEntry {
  level: LogLevel;
  ts: string;
  msg: string;
  requestId?: string;
  [key: string]: unknown;
}

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...data,
  };

  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    line = JSON.stringify({
      level: entry.level,
      ts: entry.ts,
      msg: entry.msg,
      error: 'unserializable log data',
    });
  }

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
};

/** Create a child logger that always includes a request ID */
export function withRequestId(requestId: string) {
  return {
    debug: (msg: string, data?: Record<string, unknown>) =>
      emit('debug', msg, { ...data, requestId }),
    info: (msg: string, data?: Record<string, unknown>) =>
      emit('info', msg, { ...data, requestId }),
    warn: (msg: string, data?: Record<string, unknown>) =>
      emit('warn', msg, { ...data, requestId }),
    error: (msg: string, data?: Record<string, unknown>) =>
      emit('error', msg, { ...data, requestId }),
  };
}
