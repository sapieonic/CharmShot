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
