/**
 * End-to-end webhook + rate-limit integration tests through the REAL router.
 *
 * Mocks ONLY Firebase auth (not needed for the public webhook route, but the
 * rate-limit test hits an authed route). MongoDB is real: webhook_events state
 * is verified directly.
 *
 * NOTE: the Razorpay integration is currently a shell — signature verification
 * only checks header presence and no entitlement changes are applied yet, so
 * these tests cover routing, gating, idempotency, and the response envelope.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID, buildRazorpayWebhook } from '../../helpers/fakes';
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

const WEBHOOK_ROUTE = '/v1/webhooks/razorpay';
// Any non-empty signature passes the shell verifier (see paymentService.ts);
// PAYMENTS_ENABLED=true and RAZORPAY_WEBHOOK_SECRET come from tests/setup.ts.
const SIGNATURE = 'test-signature';

function webhookRequest(eventId: string | undefined, body: Record<string, unknown>) {
  return buildRequest({
    method: 'POST',
    routePath: WEBHOOK_ROUTE,
    headers: {
      'x-razorpay-signature': SIGNATURE,
      ...(eventId ? { 'x-razorpay-event-id': eventId } : {}),
    },
    body,
  });
}

describe.skipIf(!mongoAvailable)('webhook + rate-limit flow (integration)', () => {
  beforeEach(async () => {
    await clearCollections();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('accepts a valid Razorpay webhook and records the event in Mongo', async () => {
    const res = await dispatch(webhookRequest('evt-purchase-1', buildRazorpayWebhook()));

    expect(res.statusCode).toBe(200);
    expect(parseBody<{ status: string }>(res.body).status).toBe('processed');

    const { webhookEvents } = await collections();
    const event = await webhookEvents.findOne({ eventId: 'evt-purchase-1' });
    expect(event?.type).toBe('payment.captured');
    expect(await webhookEvents.countDocuments({ eventId: 'evt-purchase-1' })).toBe(1);
  });

  it('is idempotent: a duplicate event id is acknowledged but not re-recorded', async () => {
    const body = buildRazorpayWebhook();

    const first = await dispatch(webhookRequest('evt-dup-1', body));
    expect(parseBody<{ status: string }>(first.body).status).toBe('processed');

    // Re-deliver the SAME event id.
    const second = await dispatch(webhookRequest('evt-dup-1', body));
    expect(second.statusCode).toBe(200);
    expect(parseBody<{ status: string }>(second.body).status).toBe('duplicate');

    const { webhookEvents } = await collections();
    expect(await webhookEvents.countDocuments({ eventId: 'evt-dup-1' })).toBe(1);
  });

  it('falls back to a body hash for idempotency when no event id header is sent', async () => {
    const body = buildRazorpayWebhook({ event: 'order.paid' });

    const first = await dispatch(webhookRequest(undefined, body));
    expect(parseBody<{ status: string }>(first.body).status).toBe('processed');

    const second = await dispatch(webhookRequest(undefined, body));
    expect(parseBody<{ status: string }>(second.body).status).toBe('duplicate');

    const { webhookEvents } = await collections();
    expect(await webhookEvents.countDocuments({ type: 'order.paid' })).toBe(1);
  });

  it('rejects a webhook with a missing signature (401) and records nothing', async () => {
    const res = await dispatch(
      buildRequest({ method: 'POST', routePath: WEBHOOK_ROUTE, body: buildRazorpayWebhook() }),
    );
    expect(res.statusCode).toBe(401);

    const { webhookEvents } = await collections();
    expect(await webhookEvents.countDocuments({})).toBe(0);
  });

  it('rejects a malformed payload (400) and records nothing', async () => {
    const res = await dispatch(webhookRequest('evt-bad-payload', { entity: 'event' }));
    expect(res.statusCode).toBe(400);

    const { webhookEvents } = await collections();
    expect(await webhookEvents.countDocuments({})).toBe(0);
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
