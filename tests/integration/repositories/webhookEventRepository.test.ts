/**
 * Integration tests for webhookEventRepository against a REAL MongoDB.
 *
 * The idempotency guarantee relies on the unique index on webhook_events.eventId.
 * getDb() ensures indexes once per process, so the duplicate-key path is real.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID } from '../../helpers/fakes';
import { collections } from '../../../src/db/mongo';
import { recordWebhookEventOnce } from '../../../src/repositories/webhookEventRepository';

describe.skipIf(!mongoAvailable)('webhookEventRepository (integration)', () => {
  beforeEach(async () => {
    await clearCollections();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('returns true the first time an eventId is recorded', async () => {
    const first = await recordWebhookEventOnce({
      eventId: 'evt-1',
      type: 'INITIAL_PURCHASE',
      uid: TEST_UID,
      payloadHash: 'hash-1',
    });
    expect(first).toBe(true);

    const { webhookEvents } = await collections();
    const doc = await webhookEvents.findOne({ eventId: 'evt-1' });
    expect(doc?.type).toBe('INITIAL_PURCHASE');
    expect(doc?.uid).toBe(TEST_UID);
    expect(doc?.payloadHash).toBe('hash-1');
    expect(doc?.receivedAt).toBeInstanceOf(Date);
  });

  it('returns false for a duplicate eventId (unique index enforced)', async () => {
    const first = await recordWebhookEventOnce({
      eventId: 'evt-dup',
      type: 'RENEWAL',
      uid: TEST_UID,
      payloadHash: 'hash-a',
    });
    const second = await recordWebhookEventOnce({
      eventId: 'evt-dup',
      type: 'RENEWAL',
      // Different payload/uid must NOT create a second row — eventId is the key.
      uid: 'other-uid',
      payloadHash: 'hash-b',
    });

    expect(first).toBe(true);
    expect(second).toBe(false);

    const { webhookEvents } = await collections();
    expect(await webhookEvents.countDocuments({ eventId: 'evt-dup' })).toBe(1);
    // The original document is preserved (not overwritten).
    const doc = await webhookEvents.findOne({ eventId: 'evt-dup' });
    expect(doc?.payloadHash).toBe('hash-a');
    expect(doc?.uid).toBe(TEST_UID);
  });

  it('omits uid when not provided', async () => {
    await recordWebhookEventOnce({ eventId: 'evt-no-uid', type: 'TRANSFER', payloadHash: 'h' });
    const { webhookEvents } = await collections();
    const doc = await webhookEvents.findOne({ eventId: 'evt-no-uid' });
    expect(doc).not.toBeNull();
    expect(doc?.uid).toBeUndefined();
  });

  it('treats distinct eventIds independently', async () => {
    expect(await recordWebhookEventOnce({ eventId: 'evt-x', type: 'RENEWAL', payloadHash: 'h' })).toBe(true);
    expect(await recordWebhookEventOnce({ eventId: 'evt-y', type: 'RENEWAL', payloadHash: 'h' })).toBe(true);
    const { webhookEvents } = await collections();
    expect(await webhookEvents.countDocuments({})).toBe(2);
  });
});
