import { describe, test, expect } from 'bun:test';
import { buildHeaders } from '../src/adapters/generic-http.js';
import type { NodeDefinition } from '../src/types/index.js';

function makeNode(authOverride: NodeDefinition['auth']): NodeDefinition {
  return {
    id: 'test-node',
    label: 'Test Node',
    endpoint: 'http://localhost:8080',
    transport: 'http',
    enabled: true,
    capabilities: ['reasoning'],
    tags: ['local'],
    auth: authOverride,
    health: { endpoint: '/health', intervalMs: 30000, timeoutMs: 5000, unhealthyAfter: 3 },
    timeout: { requestMs: 120000, connectMs: 5000 },
    priority: 10,
    providerType: 'generic-http',
  };
}

describe('buildHeaders (generic-http)', () => {
  test('auth.type "none" produces only Content-Type', () => {
    const node = makeNode({ type: 'none' });
    const headers = buildHeaders(node);

    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  test('auth.type "bearer" sets Authorization header', () => {
    const node = makeNode({ type: 'bearer', token: 'my-secret-token' });
    const headers = buildHeaders(node);

    expect(headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer my-secret-token',
    });
  });

  test('auth.type "bearer" without token does not set Authorization', () => {
    const node = makeNode({ type: 'bearer' });
    const headers = buildHeaders(node);

    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  test('auth.type "header" sets custom header', () => {
    const node = makeNode({
      type: 'header',
      headerName: 'X-Api-Key',
      headerValue: 'key-12345',
    });
    const headers = buildHeaders(node);

    expect(headers).toEqual({
      'Content-Type': 'application/json',
      'X-Api-Key': 'key-12345',
    });
  });

  test('auth.type "header" without headerName does not set custom header', () => {
    const node = makeNode({
      type: 'header',
      headerValue: 'key-12345',
    });
    const headers = buildHeaders(node);

    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });

  test('auth.type "header" without headerValue does not set custom header', () => {
    const node = makeNode({
      type: 'header',
      headerName: 'X-Api-Key',
    });
    const headers = buildHeaders(node);

    expect(headers).toEqual({ 'Content-Type': 'application/json' });
  });
});
