/**
 * Verifies the PAYMENTS_ENABLED=false gate. Lives in its own file because the
 * config module is mocked wholesale (the real `config` is frozen at import
 * time from tests/setup.ts, where payments are enabled).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/env')>();
  return {
    ...actual,
    config: {
      ...actual.config,
      payments: { ...actual.config.payments, enabled: false },
    },
  };
});

import { assertPaymentsEnabled } from '../../../src/services/paymentService';
import { handleRazorpayWebhook } from '../../../src/api/webhookHandler';
import { rootLogger } from '../../../src/shared/logger';
import { AppError } from '../../../src/shared/errors';
import type { HttpRequest } from '../../../src/http/apiTypes';

describe('payments disabled (PAYMENTS_ENABLED=false)', () => {
  it('assertPaymentsEnabled throws 503 SERVICE_UNAVAILABLE', () => {
    try {
      assertPaymentsEnabled();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('SERVICE_UNAVAILABLE');
      expect((err as AppError).statusCode).toBe(503);
    }
  });

  it('the Razorpay webhook handler rejects before reading the payload', async () => {
    const req: HttpRequest = {
      method: 'POST',
      routePath: '/v1/webhooks/razorpay',
      rawPath: '/v1/webhooks/razorpay',
      headers: { 'x-razorpay-signature': 'sig' },
      pathParameters: {},
      query: {},
      body: {},
      rawBody: '{}',
      requestId: 'req-1',
    };
    await expect(handleRazorpayWebhook(req, rootLogger)).rejects.toMatchObject({
      statusCode: 503,
    });
  });
});
