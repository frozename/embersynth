import type { TraceStore } from '../tracing/store.js';

export function handleListTraces(store: TraceStore, url: URL): Response {
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam ? parseInt(limitParam, 10) : 50;

  const traces = store.listTraces(Number.isFinite(limit) && limit > 0 ? limit : 50);
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
