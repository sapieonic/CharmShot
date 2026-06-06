/**
 * Integration tests for userRepository against a REAL MongoDB.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID } from '../../helpers/fakes';
import { collections } from '../../../src/db/mongo';
import { findUser, upsertUser } from '../../../src/repositories/userRepository';

describe.skipIf(!mongoAvailable)('userRepository (integration)', () => {
  beforeEach(async () => {
    await clearCollections();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('inserts a user on first upsert', async () => {
    const user = await upsertUser({ uid: TEST_UID, email: 'a@example.com', name: 'Alice' });
    expect(user.uid).toBe(TEST_UID);
    expect(user.email).toBe('a@example.com');
    expect(user.name).toBe('Alice');
    expect(user.createdAt).toBeInstanceOf(Date);

    const found = await findUser(TEST_UID);
    expect(found?.email).toBe('a@example.com');
  });

  it('updates without nulling existing email/name when called with partial claims', async () => {
    const first = await upsertUser({ uid: TEST_UID, email: 'a@example.com', name: 'Alice' });

    // Second upsert with only uid (e.g. a token without email/name claims).
    const second = await upsertUser({ uid: TEST_UID });

    expect(second.email).toBe('a@example.com');
    expect(second.name).toBe('Alice');
    // createdAt preserved, updatedAt advanced.
    expect(second.createdAt.getTime()).toBe(first.createdAt.getTime());
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
  });

  it('updates email/name when new claims are present', async () => {
    await upsertUser({ uid: TEST_UID, email: 'a@example.com', name: 'Alice' });
    const updated = await upsertUser({ uid: TEST_UID, email: 'b@example.com', name: 'Bob' });
    expect(updated.email).toBe('b@example.com');
    expect(updated.name).toBe('Bob');
  });

  it('keeps uid unique (no duplicate documents)', async () => {
    await upsertUser({ uid: TEST_UID, email: 'a@example.com' });
    await upsertUser({ uid: TEST_UID, email: 'a@example.com' });
    await upsertUser({ uid: TEST_UID, name: 'Alice' });

    const { users } = await collections();
    expect(await users.countDocuments({ uid: TEST_UID })).toBe(1);
  });
});
