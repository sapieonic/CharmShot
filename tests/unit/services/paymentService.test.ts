import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRazorpayWebhook } from '../../helpers/fakes';

// In-memory idempotency store backing recordWebhookEventOnce.
const { seenEventIds, recordWebhookEventOnce, audit } = vi.hoisted(() => {
  const seen = new Set<string>();
  return {
    seenEventIds: seen,
    recordWebhookEventOnce: vi.fn(async (e: { eventId: string }) => {
      if (seen.has(e.eventId)) return false;
      seen.add(e.eventId);
      return true;
    }),
    audit: vi.fn(async () => undefined),
  };
});
vi.mock('../../../src/repositories/webhookEventRepository', () => ({ recordWebhookEventOnce }));
vi.mock('../../../src/repositories/auditLogRepository', () => ({ audit }));

import {
  assertPaymentsEnabled,
  createOrder,
  processRazorpayEvent,
  verifyWebhookSignature,
} from '../../../src/services/paymentService';
import { rootLogger } from '../../../src/shared/logger';
import { AppError } from '../../../src/shared/errors';

describe('assertPaymentsEnabled', () => {
  it('passes when PAYMENTS_ENABLED=true (tests/setup.ts)', () => {
    expect(() => assertPaymentsEnabled()).not.toThrow();
  });
});

describe('verifyWebhookSignature (shell)', () => {
  it('accepts a request carrying a signature header', async () => {
    await expect(verifyWebhookSignature('{}', 'some-signature')).resolves.toBeUndefined();
  });

  it('rejects a missing signature header with 401', async () => {
    const err = await verifyWebhookSignature('{}', undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).statusCode).toBe(401);
  });
});

describe('processRazorpayEvent idempotency', () => {
  beforeEach(() => {
    seenEventIds.clear();
    vi.clearAllMocks();
  });

  it('processes a new event and records it in the audit log', async () => {
    const payload = buildRazorpayWebhook();
    const res = await processRazorpayEvent(payload, JSON.stringify(payload), 'evt-1', rootLogger);
    expect(res.status).toBe('processed');
    expect(recordWebhookEventOnce).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'evt-1', type: 'payment.captured' }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'webhook.razorpay' }),
    );
  });

  it('ignores a duplicate delivery of the same event id', async () => {
    const payload = buildRazorpayWebhook();
    const body = JSON.stringify(payload);
    await processRazorpayEvent(payload, body, 'evt-dup', rootLogger);
    audit.mockClear();

    const res = await processRazorpayEvent(payload, body, 'evt-dup', rootLogger);
    expect(res.status).toBe('duplicate');
    expect(audit).not.toHaveBeenCalled();
  });

  it('falls back to a body hash for idempotency when the event id header is absent', async () => {
    const payload = buildRazorpayWebhook();
    const body = JSON.stringify(payload);
    const first = await processRazorpayEvent(payload, body, undefined, rootLogger);
    const second = await processRazorpayEvent(payload, body, undefined, rootLogger);
    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');
  });
});

describe('createOrder (shell)', () => {
  it('is not implemented yet', async () => {
    await expect(
      createOrder({ uid: 'uid-1', amountInPaise: 49900 }),
    ).rejects.toThrowError(AppError);
  });
});
