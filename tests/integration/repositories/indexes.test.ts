/**
 * Integration tests asserting the expected MongoDB indexes are ensured.
 *
 * getDb() (called transitively via collections() / clearCollections()) runs
 * ensureIndexes() once per process, so the unique indexes the repositories rely
 * on for atomicity/idempotency must be present.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { IndexDescription } from 'mongodb';
import { clearCollections, closeTestDb, getTestDb, mongoAvailable } from '../../helpers/db';
import { Collections } from '../../../src/db/mongo';

interface IndexInfo {
  key: Record<string, number>;
  unique?: boolean;
  expireAfterSeconds?: number;
}

/** Find an index whose key matches the given spec exactly. */
function findIndex(indexes: IndexInfo[], spec: Record<string, number>): IndexInfo | undefined {
  const specKeys = Object.keys(spec);
  return indexes.find((idx) => {
    const idxKeys = Object.keys(idx.key);
    if (idxKeys.length !== specKeys.length) return false;
    return specKeys.every((k) => idx.key[k] === spec[k]);
  });
}

describe.skipIf(!mongoAvailable)('MongoDB indexes (integration)', () => {
  beforeEach(async () => {
    // Triggers getDb() -> ensureIndexes() if not already ensured this process.
    await clearCollections();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('users has a unique index on uid', async () => {
    const db = await getTestDb();
    const indexes = (await db.collection(Collections.users).indexes()) as IndexInfo[];
    const idx = findIndex(indexes, { uid: 1 });
    expect(idx).toBeDefined();
    expect(idx?.unique).toBe(true);
  });

  it('jobs has a unique index on jobId and a (uid, createdAt desc) index', async () => {
    const db = await getTestDb();
    const indexes = (await db.collection(Collections.jobs).indexes()) as IndexInfo[];
    const unique = findIndex(indexes, { jobId: 1 });
    expect(unique?.unique).toBe(true);

    const listing = findIndex(indexes, { uid: 1, createdAt: -1 });
    expect(listing).toBeDefined();
  });

  it('entitlements has a unique index on uid', async () => {
    const db = await getTestDb();
    const indexes = (await db.collection(Collections.entitlements).indexes()) as IndexInfo[];
    const idx = findIndex(indexes, { uid: 1 });
    expect(idx?.unique).toBe(true);
  });

  it('webhook_events has a unique index on eventId', async () => {
    const db = await getTestDb();
    const indexes = (await db.collection(Collections.webhookEvents).indexes()) as IndexInfo[];
    const idx = findIndex(indexes, { eventId: 1 });
    expect(idx?.unique).toBe(true);
  });

  it('rate_limits has a TTL index on expiresAt', async () => {
    const db = await getTestDb();
    const indexes = (await db.collection(Collections.rateLimits).indexes()) as IndexInfo[];
    const idx = findIndex(indexes, { expiresAt: 1 });
    expect(idx).toBeDefined();
    expect(idx?.expireAfterSeconds).toBe(0);
  });

  // Touch the IndexDescription import so it is part of the type surface used.
  it('index specs are well-formed', () => {
    const spec: IndexDescription = { key: { uid: 1 }, unique: true };
    expect(spec.unique).toBe(true);
    expect((spec.key as Record<string, number>).uid).toBe(1);
  });
});
