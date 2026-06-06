/**
 * RevenueCat webhook service.
 *
 * - Verifies authenticity by comparing the incoming Authorization header to a
 *   shared secret configured via the REVENUECAT_WEBHOOK_AUTH env var (RevenueCat
 *   lets you set an arbitrary Authorization header value on the webhook).
 * - Idempotent: each event id is recorded once in webhook_events; duplicate
 *   deliveries are acknowledged but not re-applied.
 * - Maps RevenueCat app_user_id -> Firebase uid and updates entitlements,
 *   plan, and credits based on the event type.
 */

import { timingSafeEqual } from 'node:crypto';
import { config } from '../config/env';
import { hashPayload } from '../shared/ids';
import { Errors } from '../shared/errors';
import type { Logger } from '../shared/logger';
import { recordWebhookEventOnce } from '../repositories/webhookEventRepository';
import { applyEntitlementUpdate } from '../repositories/entitlementRepository';
import { audit } from '../repositories/auditLogRepository';
import type { RevenueCatWebhook } from '../validation/schemas';
import type { Plan } from '../shared/types';

/** Credits granted when a plan becomes/renews active. Tune per product. */
const PLAN_CREDIT_GRANT: Record<string, number> = {
  free: config.credits.freeTierCredits,
  pro: 200,
  premium: 1000,
};

/** Map a RevenueCat entitlement/product id to an internal plan name. */
function resolvePlan(event: RevenueCatWebhook['event']): Plan {
  const ent = event.entitlement_ids?.[0] ?? event.entitlement_id ?? event.product_id ?? '';
  const lower = ent.toLowerCase();
  if (lower.includes('premium')) return 'premium';
  if (lower.includes('pro')) return 'pro';
  return 'pro'; // default paid plan when we can't classify but it's a purchase
}

export async function verifyWebhookAuth(authorizationHeader: string | undefined): Promise<void> {
  const expected = config.revenuecat.webhookAuth;
  if (!expected) {
    throw Errors.internal('REVENUECAT_WEBHOOK_AUTH is not configured');
  }
  const provided = authorizationHeader ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Errors.unauthorized('Invalid webhook signature');
  }
}

export interface WebhookResult {
  status: 'processed' | 'duplicate';
}

/**
 * Process a verified RevenueCat webhook payload. Idempotent by event id.
 */
export async function processRevenueCatEvent(
  payload: RevenueCatWebhook,
  rawBody: string,
  logger: Logger,
): Promise<WebhookResult> {
  const event = payload.event;
  const uid = event.app_user_id; // App configures app_user_id = Firebase uid.

  // Idempotency gate: only the first delivery proceeds.
  const isFirst = await recordWebhookEventOnce({
    eventId: event.id,
    type: event.type,
    uid,
    payloadHash: hashPayload(rawBody),
  });
  if (!isFirst) {
    logger.info('Duplicate webhook event ignored', { eventId: event.id, type: event.type });
    return { status: 'duplicate' };
  }

  await applyEventToEntitlement(uid, event, logger);
  await audit({ uid, action: 'webhook.revenuecat', meta: { type: event.type, eventId: event.id } });
  return { status: 'processed' };
}

async function applyEventToEntitlement(
  uid: string,
  event: RevenueCatWebhook['event'],
  logger: Logger,
): Promise<void> {
  const type = event.type.toUpperCase();

  switch (type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'NON_RENEWING_PURCHASE':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE': {
      const plan = resolvePlan(event);
      await applyEntitlementUpdate(uid, {
        plan,
        entitlementActive: true,
        setCredits: PLAN_CREDIT_GRANT[plan] ?? PLAN_CREDIT_GRANT.pro,
      });
      logger.info('Entitlement activated', { uid, plan, type });
      break;
    }

    case 'CANCELLATION':
      // Access continues until expiration; we keep current plan/credits but
      // record that the user cancelled.
      logger.info('Subscription cancelled (still active until expiry)', { uid, type });
      break;

    case 'EXPIRATION':
    case 'SUBSCRIPTION_PAUSED':
    case 'BILLING_ISSUE': {
      await applyEntitlementUpdate(uid, {
        plan: 'free',
        entitlementActive: false,
        setCredits: PLAN_CREDIT_GRANT.free,
      });
      logger.info('Entitlement downgraded to free', { uid, type });
      break;
    }

    case 'TRANSFER':
      logger.info('Transfer event received (no entitlement change applied)', { uid, type });
      break;

    default:
      logger.warn('Unhandled RevenueCat event type', { uid, type });
  }
}
