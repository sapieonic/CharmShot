import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory idempotency store backing recordWebhookEventOnce.
const { seenEventIds, recordWebhookEventOnce, applyEntitlementUpdate, audit } = vi.hoisted(() => {
  const seen = new Set<string>();
  return {
    seenEventIds: seen,
    recordWebhookEventOnce: vi.fn(async (e: { eventId: string }) => {
      if (seen.has(e.eventId)) return false;
      seen.add(e.eventId);
      return true;
    }),
    applyEntitlementUpdate: vi.fn(async () => ({})),
    audit: vi.fn(async () => undefined),
  };
});
vi.mock('../src/repositories/webhookEventRepository', () => ({ recordWebhookEventOnce }));
vi.mock('../src/repositories/entitlementRepository', () => ({ applyEntitlementUpdate }));
vi.mock('../src/repositories/auditLogRepository', () => ({ audit }));

import { processRevenueCatEvent, verifyWebhookAuth } from '../src/services/webhookService';
import { rootLogger } from '../src/shared/logger';
import { AppError } from '../src/shared/errors';
import type { RevenueCatWebhook } from '../src/validation/schemas';

function makeEvent(overrides: Partial<RevenueCatWebhook['event']> = {}): RevenueCatWebhook {
  return {
    api_version: '1.0',
    event: {
      id: 'evt-1',
      type: 'INITIAL_PURCHASE',
      app_user_id: 'uid-firebase-1',
      entitlement_ids: ['pro'],
      ...overrides,
    },
  };
}

describe('verifyWebhookAuth', () => {
  it('accepts the configured shared secret', async () => {
    await expect(verifyWebhookAuth('test-webhook-secret')).resolves.toBeUndefined();
  });

  it('rejects a wrong or missing secret', async () => {
    await expect(verifyWebhookAuth('wrong')).rejects.toThrowError(AppError);
    await expect(verifyWebhookAuth(undefined)).rejects.toThrowError(AppError);
  });
});

describe('processRevenueCatEvent idempotency', () => {
  beforeEach(() => {
    seenEventIds.clear();
    vi.clearAllMocks();
  });

  it('processes a new event and updates entitlements', async () => {
    const payload = makeEvent();
    const res = await processRevenueCatEvent(payload, JSON.stringify(payload), rootLogger);
    expect(res.status).toBe('processed');
    expect(applyEntitlementUpdate).toHaveBeenCalledWith(
      'uid-firebase-1',
      expect.objectContaining({ plan: 'pro', entitlementActive: true }),
    );
  });

  it('ignores a duplicate delivery of the same event id', async () => {
    const payload = makeEvent();
    const body = JSON.stringify(payload);
    await processRevenueCatEvent(payload, body, rootLogger);
    applyEntitlementUpdate.mockClear();

    const res = await processRevenueCatEvent(payload, body, rootLogger);
    expect(res.status).toBe('duplicate');
    expect(applyEntitlementUpdate).not.toHaveBeenCalled();
  });

  it('downgrades to free on EXPIRATION', async () => {
    const payload = makeEvent({ id: 'evt-exp', type: 'EXPIRATION' });
    await processRevenueCatEvent(payload, JSON.stringify(payload), rootLogger);
    expect(applyEntitlementUpdate).toHaveBeenCalledWith(
      'uid-firebase-1',
      expect.objectContaining({ plan: 'free', entitlementActive: false }),
    );
  });

  it('maps app_user_id to the Firebase uid', async () => {
    const payload = makeEvent({ id: 'evt-2', app_user_id: 'uid-xyz' });
    await processRevenueCatEvent(payload, JSON.stringify(payload), rootLogger);
    expect(applyEntitlementUpdate).toHaveBeenCalledWith('uid-xyz', expect.any(Object));
  });
});
