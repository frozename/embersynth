export interface TraceEvent {
  traceId: string;
  timestamp: number;
  phase: 'classify' | 'plan' | 'execute-stage' | 'execute-complete' | 'error';
  data: Record<string, unknown>;
}

export class TraceStore {
  private buffer: Map<string, TraceEvent[]>;
  private order: string[]; // track insertion order for eviction
  private maxTraces: number;

  constructor(maxTraces: number = 1000) {
    this.buffer = new Map();
    this.order = [];
    this.maxTraces = Math.max(1, maxTraces);
  }

  record(event: TraceEvent): void {
    const { traceId } = event;
    const isNew = !this.buffer.has(traceId);

    if (isNew) {
      // Evict oldest trace if at capacity
      while (this.order.length >= this.maxTraces) {
        const oldest = this.order.shift()!;
        this.buffer.delete(oldest);
      }
      this.buffer.set(traceId, []);
      this.order.push(traceId);
    }

    this.buffer.get(traceId)!.push(event);
  }

  getTrace(traceId: string): TraceEvent[] | undefined {
    return this.buffer.get(traceId);
  }

  listTraces(limit: number = 50): { traceId: string; startedAt: number; eventCount: number }[] {
    const result: { traceId: string; startedAt: number; eventCount: number }[] = [];

    // Return most recent first (reverse of insertion order)
    const ids = this.order.slice().reverse();
    const count = Math.min(limit, ids.length);

    for (let i = 0; i < count; i++) {
      const traceId = ids[i];
      const events = this.buffer.get(traceId)!;
      result.push({
        traceId,
        startedAt: events[0].timestamp,
        eventCount: events.length,
      });
    }

    return result;
  }

  clear(): void {
    this.buffer.clear();
    this.order = [];
  }
}
