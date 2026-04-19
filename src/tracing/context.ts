import { TraceStore, type TraceEvent } from './store.js';

export function generateTraceId(): string {
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface TraceContext {
  traceId: string;
  record(phase: TraceEvent['phase'], data: Record<string, unknown>): void;
}

export function createTraceContext(store: TraceStore, traceId: string): TraceContext {
  return {
    traceId,
    record(phase: TraceEvent['phase'], data: Record<string, unknown>): void {
      store.record({
        traceId,
        timestamp: Date.now(),
        phase,
        data,
      });
    },
  };
}
