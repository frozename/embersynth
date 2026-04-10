import type { TraceStore } from '../tracing/store.js';

export function handleListTraces(store: TraceStore, url: URL): Response {
  const limitParam = url.searchParams.get('limit');
  const DEFAULT_LIMIT = 50;
  const MAX_LIMIT = 500;
  const parsed = limitParam ? parseInt(limitParam, 10) : DEFAULT_LIMIT;
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;

  const traces = store.listTraces(limit);
  return Response.json({ traces });
}

export function handleGetTrace(store: TraceStore, traceId: string): Response {
  const events = store.getTrace(traceId);

  if (!events) {
    return Response.json(
      { error: { message: `Trace "${traceId}" not found`, type: 'not_found' } },
      { status: 404 },
    );
  }

  return Response.json({ traceId, events });
}
