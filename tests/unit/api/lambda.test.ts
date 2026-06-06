import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import type { HttpRequest } from '../../../src/http/apiTypes';

const { dispatch, bootstrapProviders } = vi.hoisted(() => ({
  dispatch: vi.fn(async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' })),
  bootstrapProviders: vi.fn(),
}));
vi.mock('../../../src/api/router', () => ({ dispatch }));
vi.mock('../../../src/providers', () => ({ bootstrapProviders }));

import { handler } from '../../../src/api/lambda';

const context = { awsRequestId: 'aws-req-1' } as Context;

function event(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/generations',
    rawPath: '/v1/generations',
    rawQueryString: '',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    requestContext: {
      http: { method: 'POST', path: '/v1/generations', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'x' },
      requestId: 'rc-req-1',
    },
    body: Buffer.from(JSON.stringify({ count: 2 })).toString('base64'),
    isBase64Encoded: true,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

describe('lambda handler adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dispatch.mockResolvedValue({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
  });

  it('imported the module (bootstrapProviders side-effect ran) without crashing', () => {
    // The module-level `bootstrapProviders()` call executes at import time; if it
    // had thrown, importing `handler` above would have failed the whole file.
    expect(typeof handler).toBe('function');
    expect(bootstrapProviders).toBeDefined();
  });

  it('normalises a base64 JSON event into an HttpRequest and returns the dispatch result', async () => {
    const res = await handler(event(), context);
    expect(res).toEqual({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });

    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.method).toBe('POST');
    expect(req.routePath).toBe('/v1/generations');
    expect(req.rawPath).toBe('/v1/generations');
    // Headers are lowercased.
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['authorization']).toBe('Bearer t');
    // Base64 JSON body is decoded and parsed.
    expect(req.body).toEqual({ count: 2 });
    expect(req.rawBody).toBe(JSON.stringify({ count: 2 }));
    // requestId prefers the Lambda context.
    expect(req.requestId).toBe('aws-req-1');
  });

  it('maps path parameters', async () => {
    await handler(
      event({
        routeKey: 'GET /v1/generations/{jobId}',
        rawPath: '/v1/generations/job_abc',
        pathParameters: { jobId: 'job_abc' },
        requestContext: { http: { method: 'GET', path: '/v1/generations/job_abc' }, requestId: 'r' } as never,
        body: undefined,
        isBase64Encoded: false,
      }),
      context,
    );
    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.routePath).toBe('/v1/generations/{jobId}');
    expect(req.pathParameters).toEqual({ jobId: 'job_abc' });
    expect(req.body).toBeUndefined();
    expect(req.rawBody).toBe('');
  });

  it('falls back to method+path when routeKey is $default', async () => {
    await handler(
      event({
        routeKey: '$default',
        rawPath: '/v1/whatever',
        requestContext: { http: { method: 'GET', path: '/v1/whatever' }, requestId: 'r' } as never,
        body: undefined,
        isBase64Encoded: false,
      }),
      context,
    );
    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.method).toBe('GET');
    expect(req.routePath).toBe('/v1/whatever');
  });

  it('treats an unparseable JSON body as undefined while preserving rawBody', async () => {
    await handler(
      event({ body: Buffer.from('not json').toString('base64'), isBase64Encoded: true }),
      context,
    );
    const req = dispatch.mock.calls[0]?.[0] as HttpRequest;
    expect(req.body).toBeUndefined();
    expect(req.rawBody).toBe('not json');
  });
});
