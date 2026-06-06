/**
 * End-to-end webhook + rate-limit integration tests through the REAL router.
 *
 * Mocks ONLY Firebase auth (not needed for the public webhook route, but the
 * rate-limit test hits an authed route). MongoDB is real: webhook_events and
 * entitlements state is verified directly.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID } from '../../helpers/fakes';
import { authedRequest, buildRequest, parseBody } from './requestBuilder';

vi.mock('../../../src/auth/firebase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth/firebase')>();
  const { fakeVerifier } = await import('../../helpers/fakes');
  const verifier = fakeVerifier();
  return {
    ...actual,
    extractBearerToken: actual.extractBearerToken,
    verifyIdToken: verifier.verifyIdToken,
    defaultVerifier: verifier,
  };
});

import { dispatch } from '../../../src/api/router';
import { collections } from '../../../src/db/mongo';
import { config } from '../../../src/config/env';

const WEBHOOK_ROUTE = '/v1/webhooks/revenuecat';
const WEBHOOK_SECRET = 'test-webhook-secret'; // matches REVENUECAT_WEBHOOK_AUTH in tests/setup.ts

function webhookBody(eventId: string, overrides: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      id: eventId,
      type: 'INITIAL_PURCHASE',
      app_user_id: TEST_UID,
      entitlement_ids: ['pro'],
      ...overrides,
    },
  };
}

describe.skipIf(!mongoAvailable)('webhook + rate-limit flow (integration)', () => {
  beforeEach(async () => {
    await clearCollections();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('processes a valid RevenueCat webhook and updates the entitlement in Mongo', async () => {
    const body = webhookBody('evt-purchase-1');
    const res = await dispatch(
      buildRequest({
        method: 'POST',
        routePath: WEBHOOK_ROUTE,
        headers: { authorization: WEBHOOK_SECRET },
        body,
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(parseBody<{ status: string }>(res.body).status).toBe('processed');

    const { entitlements, webhookEvents } = await collections();
    const ent = await entitlements.findOne({ uid: TEST_UID });
    expect(ent?.plan).toBe('pro');
    expect(ent?.entitlementActive).toBe(true);
    expect(ent?.creditsRemaining).toBe(200); // PLAN_CREDIT_GRANT.pro
    expect(await webhookEvents.countDocuments({ eventId: 'evt-purchase-1' })).toBe(1);
  });

  it('is idempotent: a duplicate event id is acknowledged but not re-applied', async () => {
    const body = webhookBody('evt-dup-1');

    const first = await dispatch(
      buildRequest({ method: 'POST', routePath: WEBHOOK_ROUTE, headers: { authorization: WEBHOOK_SECRET }, body }),
    );
    expect(parseBody<{ status: string }>(first.body).status).toBe('processed');

    const { entitlements } = await collections();
    // Mutate credits AFTER first apply to detect any unwanted re-apply.
    await entitlements.updateOne({ uid: TEST_UID }, { $set: { creditsRemaining: 5 } });

    // Re-deliver the SAME event id.
    const second = await dispatch(
      buildRequest({ method: 'POST', routePath: WEBHOOK_ROUTE, headers: { authorization: WEBHOOK_SECRET }, body }),
    );
    expect(second.statusCode).toBe(200);
    expect(parseBody<{ status: string }>(second.body).status).toBe('duplicate');

    // Entitlement was NOT reset back to 200 on the duplicate.
    const ent = await entitlements.findOne({ uid: TEST_UID });
    expect(ent?.creditsRemaining).toBe(5);

    const { webhookEvents } = await collections();
    expect(await webhookEvents.countDocuments({ eventId: 'evt-dup-1' })).toBe(1);
  });

  it('rejects a webhook with a bad secret (401) and applies nothing', async () => {
    const res = await dispatch(
      buildRequest({
        method: 'POST',
        routePath: WEBHOOK_ROUTE,
        headers: { authorization: 'wrong-secret' },
        body: webhookBody('evt-bad-secret'),
      }),
    );
    expect(res.statusCode).toBe(401);

    const { webhookEvents, entitlements } = await collections();
    expect(await webhookEvents.countDocuments({})).toBe(0);
    expect(await entitlements.countDocuments({ uid: TEST_UID })).toBe(0);
  });

  it('downgrade event sets plan free + inactive in Mongo', async () => {
    // First activate.
    await dispatch(
      buildRequest({
        method: 'POST',
        routePath: WEBHOOK_ROUTE,
        headers: { authorization: WEBHOOK_SECRET },
        body: webhookBody('evt-up'),
      }),
    );
    // Then expire.
    const res = await dispatch(
      buildRequest({
        method: 'POST',
        routePath: WEBHOOK_ROUTE,
        headers: { authorization: WEBHOOK_SECRET },
        body: webhookBody('evt-down', { type: 'EXPIRATION' }),
      }),
    );
    expect(res.statusCode).toBe(200);

    const { entitlements } = await collections();
    const ent = await entitlements.findOne({ uid: TEST_UID });
    expect(ent?.plan).toBe('free');
    expect(ent?.entitlementActive).toBe(false);
    expect(ent?.creditsRemaining).toBe(config.credits.freeTierCredits);
  });

  describe('rate limiting (Mongo-backed enforceRateLimit)', () => {
    it('allows requests under the limit', async () => {
      // A handful of authed requests well under the default (60/window) limit.
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const res = await dispatch(authedRequest({ method: 'GET', routePath: '/v1/presets' }));
        expect(res.statusCode).toBe(200);
      }

      // The rate-limit counter is tracked in Mongo for this uid.
      const { rateLimits } = await collections();
      const docs = await rateLimits.find({ uid: TEST_UID }).toArray();
      const total = docs.reduce((sum, d) => sum + d.count, 0);
      expect(total).toBeGreaterThanOrEqual(5);
    });
  });
});
