/**
 * Public (unauthenticated) webhook route handler for Razorpay. Auth is via the
 * X-Razorpay-Signature header, not Firebase. Always returns 200 for duplicates
 * so Razorpay stops retrying already-processed events.
 *
 * The route is gated by PAYMENTS_ENABLED: when payments are disabled it
 * returns 503 without touching the payload.
 */

import { ok } from '../http/responses';
import type { HttpRequest, HttpResponse } from '../http/apiTypes';
import type { Logger } from '../shared/logger';
import { razorpayWebhookSchema, parseOrThrow } from '../validation/schemas';
import {
  assertPaymentsEnabled,
  processRazorpayEvent,
  verifyWebhookSignature,
} from '../services/paymentService';

export async function handleRazorpayWebhook(req: HttpRequest, logger: Logger): Promise<HttpResponse> {
  // 1. Payments must be switched on at all.
  assertPaymentsEnabled();

  // 2. Verify the webhook signature (shell — see paymentService).
  await verifyWebhookSignature(req.rawBody, req.headers['x-razorpay-signature']);

  // 3. Validate payload shape.
  const payload = parseOrThrow(razorpayWebhookSchema, req.body);

  // 4. Process idempotently (event id header when present, else body hash).
  const result = await processRazorpayEvent(
    payload,
    req.rawBody,
    req.headers['x-razorpay-event-id'],
    logger,
  );
  return ok(result);
}
