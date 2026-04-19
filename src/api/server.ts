import pkg from '../../package.json';
import type { EmberSynthConfig } from '../types/index.js';
import type { NodeRegistry } from '../registry/registry.js';
import { handleModels } from './models.js';
import { handleCompletions } from './completions.js';
import { handleEmbeddings } from './embeddings.js';
import { handleResponses } from './responses.js';
import { handleMetrics } from './metrics.js';
import { handleListTraces, handleGetTrace } from './traces.js';
import { TraceStore } from '../tracing/store.js';
import { generateTraceId, createTraceContext } from '../tracing/context.js';
import { log } from '../logger/index.js';

export function createServer(config: EmberSynthConfig, registry: NodeRegistry) {
  const traceStore = new TraceStore();

  return Bun.serve({
    hostname: config.server.host,
    port: config.server.port,

    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const start = Date.now();
      const traceId = generateTraceId();
      const traceCtx = createTraceContext(traceStore, traceId);

      // CORS preflight
      if (method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'X-EmberSynth-Trace-Id': traceId,
          },
        });
      }

      let response: Response;

      try {
        // Route matching
        if (method === 'GET' && path === '/v1/models') {
          response = handleModels(config, registry);
        } else if (method === 'POST' && path === '/v1/chat/completions') {
          response = await handleCompletions(req, config, registry, traceCtx);
        } else if (method === 'POST' && path === '/v1/embeddings') {
          response = await handleEmbeddings(req, config, registry, traceCtx);
        } else if (method === 'POST' && path === '/v1/responses') {
          response = await handleResponses(req, config, registry, traceCtx);
        } else if (method === 'GET' && path === '/v1/traces') {
          response = handleListTraces(traceStore, url);
        } else if (method === 'GET' && path.startsWith('/v1/traces/')) {
          const requestedTraceId = path.slice('/v1/traces/'.length);
          response = handleGetTrace(traceStore, requestedTraceId);
        } else if (method === 'GET' && path === '/metrics') {
          response = handleMetrics(config, registry);
        } else if (method === 'GET' && (path === '/health' || path === '/')) {
          response = Response.json({
            status: 'ok',
            service: 'embersynth',
            version: pkg.version,
            nodes: {
              total: registry.getAll().length,
              enabled: registry.getEnabled().length,
            },
          });
        } else {
          response = Response.json(
            { error: { message: 'Not found', type: 'invalid_request_error' } },
            { status: 404 },
          );
        }
      } catch (err) {
        log.error('unhandled error', {
          path,
          method,
          error: err instanceof Error ? err.message : String(err),
        });
        response = Response.json(
          { error: { message: 'Internal server error', type: 'server_error' } },
          { status: 500 },
        );
      }

      const durationMs = Date.now() - start;
      log.debug('request handled', {
        method,
        path,
        status: response.status,
        durationMs,
      });

      // Add trace ID header to all responses
      const headers = new Headers(response.headers);
      headers.set('X-EmberSynth-Trace-Id', traceId);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  });
}
