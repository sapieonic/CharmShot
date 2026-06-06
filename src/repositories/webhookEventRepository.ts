import { collections } from '../db/mongo';
import type { WebhookEventRecord } from '../shared/types';

/**
 * Record a webhook event for idempotency. Returns true if this is the first
 * time we've seen `eventId` (i.e. the caller should process it), false if it
 * was already recorded (duplicate delivery — skip processing).
 *
 * Relies on the unique index on eventId to make the check atomic.
 */
export async function recordWebhookEventOnce(event: {
  eventId: string;
  type: string;
  uid?: string;
  payloadHash: string;
}): Promise<boolean> {
  const { webhookEvents } = await collections();
  try {
    const doc: WebhookEventRecord = {
      eventId: event.eventId,
      type: event.type,
      payloadHash: event.payloadHash,
      receivedAt: new Date(),
      ...(event.uid ? { uid: event.uid } : {}),
    };
    await webhookEvents.insertOne(doc);
    return true;
  } catch (err: unknown) {
    // Duplicate key => already processed.
    if (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000) {
      return false;
    }
    throw err;
  }
}
