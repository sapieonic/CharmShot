/**
 * Public (unauthenticated) webhook route handler for RevenueCat. Auth is via a
 * shared secret header, not Firebase. Always returns 200 for duplicates so
 * RevenueCat stops retrying already-processed events.
 */

import { ok } from '../http/responses';
import type { HttpRequest, HttpResponse } from '../http/apiTypes';
import type { Logger } from '../shared/logger';
import { revenueCatWebhookSchema, parseOrThrow } from '../validation/schemas';
import { processRevenueCatEvent, verifyWebhookAuth } from '../services/webhookService';

export async function handleRevenueCatWebhook(req: HttpRequest, logger: Logger): Promise<HttpResponse> {
  // 1. Verify the shared-secret Authorization header.
  await verifyWebhookAuth(req.headers['authorization']);

  // 2. Validate payload shape.
  const payload = parseOrThrow(revenueCatWebhookSchema, req.body);

  // 3. Process idempotently.
  const result = await processRevenueCatEvent(payload, req.rawBody, logger);
  return ok(result);
}
