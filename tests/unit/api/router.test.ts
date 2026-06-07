import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_UID } from '../../helpers/fakes';
import type { HttpRequest } from '../../../src/http/apiTypes';

const { authenticate, enforceRateLimit, handlePresign, handleRazorpayWebhook } = vi.hoisted(() => ({
  authenticate: vi.fn(),
  enforceRateLimit: vi.fn(async () => undefined),
  handlePresign: vi.fn(async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ ok: true }) })),
  handleRazorpayWebhook: vi.fn(async () => ({ statusCode: 200, headers: {}, body: JSON.stringify({ status: 'processed' }) })),
}));

vi.mock('../../../src/services/authService', () => ({ authenticate }));
vi.mock('../../../src/middleware/rateLimit', () => ({ enforceRateLimit }));
vi.mock('../../../src/api/handlers', () => ({
  handlePresign,
  handleCreateGeneration: vi.fn(),
  handleGetGeneration: vi.fn(),
  handleListPresets: vi.fn(),
  handleGetEntitlements: vi.fn(),
}));
vi.mock('../../../src/api/webhookHandler', () => ({ handleRazorpayWebhook }));

import { dispatch } from '../../../src/api/router';

function req(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return {
    method: 'GET',
    routePath: '/health',
    rawPath: '/health',
    headers: {},
    pathParameters: {},
    query: {},
    body: undefined,
    rawBody: '',
    requestId: 'req-1',
    ...overrides,
  };
}

describe('dispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticate.mockResolvedValue({ uid: TEST_UID, email: 'a@b.com' });
  });

  it('returns 404 NOT_FOUND envelope for an unknown route', async () => {
    const res = await dispatch(req({ method: 'GET', routePath: '/v1/nope', rawPath: '/v1/nope' }));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error.code).toBe('NOT_FOUND');
  });

  it('serves the public /health route without auth', async () => {
    const res = await dispatch(req({ method: 'GET', routePath: '/health' }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('reaches the webhook handler without Firebase auth', async () => {
    const res = await dispatch(
      req({ method: 'POST', routePath: '/v1/webhooks/razorpay', rawPath: '/v1/webhooks/razorpay' }),
    );
    expect(res.statusCode).toBe(200);
    expect(handleRazorpayWebhook).toHaveBeenCalledTimes(1);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects an authed route with a missing Authorization header (401)', async () => {
    const res = await dispatch(req({ method: 'POST', routePath: '/v1/uploads/presign', rawPath: '/v1/uploads/presign' }));
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.code).toBe('UNAUTHORIZED');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects an authed route with a malformed Authorization header (401)', async () => {
    const res = await dispatch(
      req({ method: 'POST', routePath: '/v1/uploads/presign', rawPath: '/v1/uploads/presign', headers: { authorization: 'Token x' } }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when token verification fails', async () => {
    authenticate.mockRejectedValueOnce(
      new (await import('../../../src/shared/errors')).AppError('UNAUTHORIZED', 'bad token'),
    );
    const res = await dispatch(
      req({ method: 'POST', routePath: '/v1/uploads/presign', rawPath: '/v1/uploads/presign', headers: { authorization: 'Bearer t' } }),
    );
    expect(res.statusCode).toBe(401);
  });

  it('invokes the handler after auth + rate limiting succeed', async () => {
    const res = await dispatch(
      req({ method: 'POST', routePath: '/v1/uploads/presign', rawPath: '/v1/uploads/presign', headers: { authorization: 'Bearer good' } }),
    );
    expect(res.statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledWith('good');
    expect(enforceRateLimit).toHaveBeenCalledWith(TEST_UID);
    expect(handlePresign).toHaveBeenCalledTimes(1);
  });

  it('returns 429 when the rate limiter rejects', async () => {
    enforceRateLimit.mockRejectedValueOnce(
      new (await import('../../../src/shared/errors')).AppError('RATE_LIMITED', 'slow down'),
    );
    const res = await dispatch(
      req({ method: 'POST', routePath: '/v1/uploads/presign', rawPath: '/v1/uploads/presign', headers: { authorization: 'Bearer good' } }),
    );
    expect(res.statusCode).toBe(429);
  });
});
