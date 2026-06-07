/**
 * Payment service — Razorpay integration (SHELL).
 *
 * The previous RevenueCat integration has been removed; Razorpay will replace
 * it. For now these are shell methods: the wiring (env gating, webhook route,
 * idempotency, audit) is real, but signature verification and the mapping from
 * payment events to plan/credit changes are TODO stubs.
 *
 * The whole payments surface is gated by PAYMENTS_ENABLED (see
 * `config.payments.enabled`); when disabled, the webhook route returns 503 and
 * no payment processing occurs.
 */

import { config } from '../config/env';
import { hashPayload } from '../shared/ids';
import { Errors } from '../shared/errors';
import type { Logger } from '../shared/logger';
import { recordWebhookEventOnce } from '../repositories/webhookEventRepository';
import { audit } from '../repositories/auditLogRepository';
import type { RazorpayWebhook } from '../validation/schemas';

/** Throws 503 unless payments are enabled via PAYMENTS_ENABLED. */
export function assertPaymentsEnabled(): void {
  if (!config.payments.enabled) {
    throw Errors.serviceUnavailable('Payments are currently disabled.');
  }
}

/**
 * Verify the X-Razorpay-Signature header for a webhook delivery.
 *
 * TODO(razorpay): implement real verification — HMAC-SHA256 of the raw body
 * keyed with RAZORPAY_WEBHOOK_SECRET, compared via timingSafeEqual against the
 * header value. Shell behaviour: requires the secret to be configured and the
 * header to be present, nothing more. NOT production-safe.
 */
export async function verifyWebhookSignature(
  _rawBody: string,
  signatureHeader: string | undefined,
): Promise<void> {
  if (!config.payments.razorpay.webhookSecret) {
    throw Errors.internal('RAZORPAY_WEBHOOK_SECRET is not configured');
  }
  if (!signatureHeader) {
    throw Errors.unauthorized('Missing webhook signature');
  }
}

export interface WebhookResult {
  status: 'processed' | 'duplicate';
}

/**
 * Process a verified Razorpay webhook payload. Idempotent by event id (the
 * X-Razorpay-Event-Id header when present, else a hash of the raw body).
 *
 * TODO(razorpay): map payment/subscription events (payment.captured,
 * subscription.activated, subscription.cancelled, ...) to entitlement updates
 * via `applyEntitlementUpdate` (src/repositories/entitlementRepository.ts),
 * the way the old RevenueCat integration granted plan credits. The uid should
 * come from `payload.<entity>.entity.notes.uid` set when creating the order.
 */
export async function processRazorpayEvent(
  payload: RazorpayWebhook,
  rawBody: string,
  eventIdHeader: string | undefined,
  logger: Logger,
): Promise<WebhookResult> {
  const payloadHash = hashPayload(rawBody);
  const eventId = eventIdHeader ?? payloadHash;

  // Idempotency gate: only the first delivery proceeds.
  const isFirst = await recordWebhookEventOnce({
    eventId,
    type: payload.event,
    payloadHash,
  });
  if (!isFirst) {
    logger.info('Duplicate webhook event ignored', { eventId, type: payload.event });
    return { status: 'duplicate' };
  }

  // TODO(razorpay): apply entitlement/credit changes per event type here.
  logger.info('Razorpay webhook event received (shell — no entitlement change applied)', {
    eventId,
    type: payload.event,
  });

  await audit({ action: 'webhook.razorpay', meta: { type: payload.event, eventId } });
  return { status: 'processed' };
}

/**
 * Create a Razorpay order for a purchase (called from a future checkout flow).
 *
 * TODO(razorpay): call POST /v1/orders with key id/secret from
 * `config.payments.razorpay`, stamping `notes.uid` so webhooks can map the
 * payment back to a Firebase user.
 */
export async function createOrder(_input: {
  uid: string;
  amountInPaise: number;
  currency?: string;
}): Promise<never> {
  assertPaymentsEnabled();
  throw Errors.internal('Razorpay createOrder is not implemented yet');
}
