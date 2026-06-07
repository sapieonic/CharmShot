import { collections } from '../db/mongo';
import { config } from '../config/env';
import type { EntitlementRecord, Plan } from '../shared/types';

/**
 * Get the user's entitlement, creating a default free-tier record on first
 * access. This is the single place free credits are granted.
 */
export async function getOrCreateEntitlement(uid: string): Promise<EntitlementRecord> {
  const { entitlements } = await collections();
  const now = new Date();
  const res = await entitlements.findOneAndUpdate(
    { uid },
    {
      $setOnInsert: {
        uid,
        plan: 'free' as Plan,
        creditsRemaining: config.credits.freeTierCredits,
        entitlementActive: true,
        lastSyncedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return res as EntitlementRecord;
}

/**
 * Atomically reserve (deduct) `amount` credits iff enough remain. Returns the
 * updated record on success, or null if there were insufficient credits.
 *
 * The conditional filter (`creditsRemaining >= amount`) makes the deduction a
 * single atomic compare-and-decrement, safe under concurrent requests.
 */
export async function reserveCredits(uid: string, amount: number): Promise<EntitlementRecord | null> {
  const { entitlements } = await collections();
  const res = await entitlements.findOneAndUpdate(
    { uid, creditsRemaining: { $gte: amount } },
    { $inc: { creditsRemaining: -amount }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return res ?? null;
}

/** Refund previously reserved credits (e.g. on job failure). */
export async function refundCredits(uid: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  const { entitlements } = await collections();
  await entitlements.updateOne(
    { uid },
    { $inc: { creditsRemaining: amount }, $set: { updatedAt: new Date() } },
  );
}

/** Apply a plan/credit update from a billing event (e.g. a Razorpay webhook). */
export async function applyEntitlementUpdate(
  uid: string,
  update: {
    plan?: Plan;
    entitlementActive?: boolean;
    setCredits?: number;
    addCredits?: number;
  },
): Promise<EntitlementRecord> {
  // Ensure a record exists first so $inc/$set operate on a real document.
  await getOrCreateEntitlement(uid);
  const { entitlements } = await collections();
  const now = new Date();

  const set: Record<string, unknown> = { lastSyncedAt: now, updatedAt: now };
  if (update.plan !== undefined) set.plan = update.plan;
  if (update.entitlementActive !== undefined) set.entitlementActive = update.entitlementActive;
  if (update.setCredits !== undefined) set.creditsRemaining = update.setCredits;

  const updateDoc: Record<string, unknown> = { $set: set };
  if (update.addCredits !== undefined && update.setCredits === undefined) {
    updateDoc.$inc = { creditsRemaining: update.addCredits };
  }

  const res = await entitlements.findOneAndUpdate({ uid }, updateDoc, { returnDocument: 'after' });
  return res as EntitlementRecord;
}
