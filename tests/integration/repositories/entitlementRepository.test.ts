/**
 * Integration tests for entitlementRepository against a REAL MongoDB.
 *
 * Skips cleanly when no MongoDB is reachable (see tests/helpers/db.ts).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID } from '../../helpers/fakes';
import { collections } from '../../../src/db/mongo';
import { config } from '../../../src/config/env';
import {
  applyEntitlementUpdate,
  getOrCreateEntitlement,
  refundCredits,
  reserveCredits,
} from '../../../src/repositories/entitlementRepository';

describe.skipIf(!mongoAvailable)('entitlementRepository (integration)', () => {
  beforeEach(async () => {
    await clearCollections();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  describe('getOrCreateEntitlement', () => {
    it('creates a free-tier doc on first access', async () => {
      const e = await getOrCreateEntitlement(TEST_UID);
      expect(e.uid).toBe(TEST_UID);
      expect(e.plan).toBe('free');
      expect(e.creditsRemaining).toBe(config.credits.freeTierCredits);
      expect(e.entitlementActive).toBe(true);

      const { entitlements } = await collections();
      expect(await entitlements.countDocuments({ uid: TEST_UID })).toBe(1);
    });

    it('is idempotent: a second call does not create a duplicate or reset credits', async () => {
      const first = await getOrCreateEntitlement(TEST_UID);
      // Mutate credits, then call again — it must NOT reset on the second call.
      await reserveCredits(TEST_UID, 3);
      const second = await getOrCreateEntitlement(TEST_UID);

      expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
      expect(second.creditsRemaining).toBe(config.credits.freeTierCredits - 3);

      const { entitlements } = await collections();
      expect(await entitlements.countDocuments({ uid: TEST_UID })).toBe(1);
    });
  });

  describe('reserveCredits', () => {
    it('deducts atomically when enough credits remain', async () => {
      await getOrCreateEntitlement(TEST_UID);
      const res = await reserveCredits(TEST_UID, 4);
      expect(res).not.toBeNull();
      expect(res?.creditsRemaining).toBe(config.credits.freeTierCredits - 4);
    });

    it('returns null and does NOT deduct when credits are insufficient', async () => {
      const { entitlements } = await collections();
      await entitlements.insertOne({
        uid: TEST_UID,
        plan: 'free',
        creditsRemaining: 2,
        entitlementActive: true,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await reserveCredits(TEST_UID, 5);
      expect(res).toBeNull();

      const after = await entitlements.findOne({ uid: TEST_UID });
      expect(after?.creditsRemaining).toBe(2);
    });

    it('is atomic under concurrency: exactly one of two full reservations succeeds', async () => {
      const { entitlements } = await collections();
      await entitlements.insertOne({
        uid: TEST_UID,
        plan: 'free',
        creditsRemaining: 5,
        entitlementActive: true,
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Two concurrent attempts to reserve the FULL balance.
      const [a, b] = await Promise.all([reserveCredits(TEST_UID, 5), reserveCredits(TEST_UID, 5)]);

      const successes = [a, b].filter((r) => r !== null);
      expect(successes).toHaveLength(1);

      const after = await entitlements.findOne({ uid: TEST_UID });
      expect(after?.creditsRemaining).toBe(0);
    });
  });

  describe('refundCredits', () => {
    it('increments the balance', async () => {
      await getOrCreateEntitlement(TEST_UID);
      await reserveCredits(TEST_UID, 6);
      await refundCredits(TEST_UID, 6);

      const { entitlements } = await collections();
      const after = await entitlements.findOne({ uid: TEST_UID });
      expect(after?.creditsRemaining).toBe(config.credits.freeTierCredits);
    });

    it('is a no-op for non-positive amounts', async () => {
      await getOrCreateEntitlement(TEST_UID);
      await refundCredits(TEST_UID, 0);
      const { entitlements } = await collections();
      const after = await entitlements.findOne({ uid: TEST_UID });
      expect(after?.creditsRemaining).toBe(config.credits.freeTierCredits);
    });
  });

  describe('applyEntitlementUpdate', () => {
    it('sets plan + setCredits', async () => {
      const res = await applyEntitlementUpdate(TEST_UID, {
        plan: 'pro',
        entitlementActive: true,
        setCredits: 200,
      });
      expect(res.plan).toBe('pro');
      expect(res.creditsRemaining).toBe(200);
      expect(res.entitlementActive).toBe(true);
    });

    it('adds credits via the addCredits path', async () => {
      await getOrCreateEntitlement(TEST_UID); // starts at freeTierCredits
      const res = await applyEntitlementUpdate(TEST_UID, { addCredits: 15 });
      expect(res.creditsRemaining).toBe(config.credits.freeTierCredits + 15);
    });

    it('prefers setCredits over addCredits when both are present', async () => {
      await getOrCreateEntitlement(TEST_UID);
      const res = await applyEntitlementUpdate(TEST_UID, { setCredits: 50, addCredits: 999 });
      expect(res.creditsRemaining).toBe(50);
    });
  });
});
