import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '../../../src/http/apiTypes';

// Mock the router so we can inspect the normalized HttpRequest the Fastify
// adapter builds, and control the response it maps back.
const { dispatch, bootstrapProviders } = vi.hoisted(() => ({
  dispatch: vi.fn(),
  bootstrapProviders: vi.fn(),
}));
vi.mock('../../../src/api/router', () => ({ dispatch }));
vi.mock('../../../src/providers', () => ({ bootstrapProviders }));

import { buildApp } from '../../../src/server/app';
import type { FastifyInstance } from 'fastify';

function okResponse(): HttpResponse {
  return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
}

describe('Fastify server adapter', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    dispatch.mockResolvedValue(okResponse());
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('registers providers at build time', () => {
    expect(bootstrapProviders).toHaveBeenCalled();
  });

  it('routes the health check through dispatch', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.method).toBe('GET');
    expect(req.routePath).toBe('/health');
  });

  it('maps :param routes to {param} and extracts path parameters', async () => {
    await app.inject({ method: 'GET', url: '/v1/generations/job_abc?foo=bar' });
    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.routePath).toBe('/v1/generations/{jobId}');
    expect(req.pathParameters).toEqual({ jobId: 'job_abc' });
    expect(req.rawPath).toBe('/v1/generations/job_abc');
    expect(req.query).toEqual({ foo: 'bar' });
  });

  it('parses JSON body, preserves rawBody, and lowercases headers', async () => {
    const payload = { count: 2 };
    await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      payload: JSON.stringify(payload),
    });
    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.body).toEqual(payload);
    expect(req.rawBody).toBe(JSON.stringify(payload));
    expect(req.headers['authorization']).toBe('Bearer t');
    expect(req.headers['content-type']).toContain('application/json');
  });

  it('maps the router HttpResponse back to the HTTP reply', async () => {
    dispatch.mockResolvedValue({
      statusCode: 201,
      headers: { 'content-type': 'application/json', 'x-test': 'yes' },
      body: '{"jobId":"job_x"}',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers['x-test']).toBe('yes');
    expect(res.json()).toEqual({ jobId: 'job_x' });
  });

  it('serves the OpenAPI spec at /openapi.json without hitting the router', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json();
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('CharmShot API');
    // /openapi.json is its own route, not delegated to dispatch.
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('serves the Swagger UI at /docs', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
  });

  it('answers CORS preflight OPTIONS for an allowed origin without hitting the router', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/v1/presets',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });
    // Preflight is short-circuited by @fastify/cors (no route 404).
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('echoes Access-Control-Allow-Origin on actual requests from an allowed origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/presets',
      headers: { origin: 'http://localhost:5173', authorization: 'Bearer t' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not authorize a disallowed origin', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/presets',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('routes unknown paths through dispatch (consistent 404 envelope)', async () => {
    dispatch.mockResolvedValue({
      statusCode: 404,
      headers: { 'content-type': 'application/json' },
      body: '{"error":{"code":"NOT_FOUND","message":"No route"}}',
    });
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.rawPath).toBe('/nope');
  });
});
