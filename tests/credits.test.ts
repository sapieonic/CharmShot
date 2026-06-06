import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitlementRecord } from '../src/shared/types';

/**
 * A minimal in-memory stand-in for the entitlements collection that faithfully
 * models the atomic, conditional findOneAndUpdate semantics used by the credit
 * logic (compare-and-decrement). This lets us test reservation/refund without a
 * real MongoDB.
 */
const store = new Map<string, EntitlementRecord>();

function matches(doc: EntitlementRecord | undefined, filter: Record<string, unknown>): doc is EntitlementRecord {
  if (!doc) return false;
  if (filter.uid !== undefined && doc.uid !== filter.uid) return false;
  const cr = filter.creditsRemaining as { $gte?: number } | undefined;
  if (cr?.$gte !== undefined && doc.creditsRemaining < cr.$gte) return false;
  return true;
}

function applyUpdate(doc: EntitlementRecord, update: Record<string, unknown>): void {
  const inc = update.$inc as Record<string, number> | undefined;
  if (inc) for (const [k, v] of Object.entries(inc)) (doc as Record<string, unknown>)[k] = ((doc as Record<string, number>)[k] ?? 0) + v;
  const set = update.$set as Record<string, unknown> | undefined;
  if (set) Object.assign(doc, set);
}

const fakeEntitlements = {
  async findOne(filter: { uid: string }) {
    return store.get(filter.uid) ?? null;
  },
  async findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    opts?: { upsert?: boolean },
  ) {
    const uid = filter.uid as string;
    const existing = store.get(uid);
    if (matches(existing, filter)) {
      applyUpdate(existing, update);
      return { ...existing };
    }
    if (!existing && opts?.upsert) {
      const onInsert = (update.$setOnInsert as Partial<EntitlementRecord>) ?? {};
      const doc = { uid, ...onInsert } as EntitlementRecord;
      applyUpdate(doc, { $set: update.$set, $inc: update.$inc });
      store.set(uid, doc);
      return { ...doc };
    }
    return null;
  },
  async updateOne(filter: { uid: string }, update: Record<string, unknown>) {
    const doc = store.get(filter.uid);
    if (doc) applyUpdate(doc, update);
    return { matchedCount: doc ? 1 : 0 };
  },
};

vi.mock('../src/db/mongo', () => ({
  collections: async () => ({ entitlements: fakeEntitlements }),
}));

import {
  getOrCreateEntitlement,
  reserveCredits,
  refundCredits,
  applyEntitlementUpdate,
} from '../src/repositories/entitlementRepository';

describe('credit reservation / refund', () => {
  beforeEach(() => {
    store.clear();
  });

  it('grants free-tier credits on first access', async () => {
    const e = await getOrCreateEntitlement('uid-1');
    expect(e.plan).toBe('free');
    expect(e.creditsRemaining).toBe(10);
    expect(e.entitlementActive).toBe(true);
  });

  it('atomically reserves credits when enough remain', async () => {
    await getOrCreateEntitlement('uid-1');
    const after = await reserveCredits('uid-1', 3);
    expect(after).not.toBeNull();
    expect(after?.creditsRemaining).toBe(7);
  });

  it('refuses to reserve more credits than available (no deduction)', async () => {
    await getOrCreateEntitlement('uid-1');
    const after = await reserveCredits('uid-1', 50);
    expect(after).toBeNull();
    const current = await getOrCreateEntitlement('uid-1');
    expect(current.creditsRemaining).toBe(10); // unchanged
  });

  it('refunds credits back to the balance', async () => {
    await getOrCreateEntitlement('uid-1');
    await reserveCredits('uid-1', 4);
    await refundCredits('uid-1', 4);
    const current = await getOrCreateEntitlement('uid-1');
    expect(current.creditsRemaining).toBe(10);
  });

  it('only allows one of two concurrent full reservations', async () => {
    await getOrCreateEntitlement('uid-1'); // 10 credits
    const [a, b] = await Promise.all([reserveCredits('uid-1', 10), reserveCredits('uid-1', 10)]);
    const successes = [a, b].filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    const current = await getOrCreateEntitlement('uid-1');
    expect(current.creditsRemaining).toBe(0);
  });

  it('applies a plan upgrade with a fresh credit grant', async () => {
    await getOrCreateEntitlement('uid-1');
    const updated = await applyEntitlementUpdate('uid-1', {
      plan: 'pro',
      entitlementActive: true,
      setCredits: 200,
    });
    expect(updated.plan).toBe('pro');
    expect(updated.creditsRemaining).toBe(200);
  });
});
