import { collections } from '../db/mongo';
import type { AuthenticatedUser, UserRecord } from '../shared/types';

/**
 * Upsert a user record from verified auth claims. Returns the stored record.
 * Only updates email/name when present so we never blank out existing values.
 */
export async function upsertUser(user: AuthenticatedUser): Promise<UserRecord> {
  const { users } = await collections();
  const now = new Date();

  const set: Partial<UserRecord> = { uid: user.uid, updatedAt: now };
  if (user.email !== undefined) set.email = user.email;
  if (user.name !== undefined) set.name = user.name;

  const res = await users.findOneAndUpdate(
    { uid: user.uid },
    {
      $set: set,
      $setOnInsert: { createdAt: now },
    },
    { upsert: true, returnDocument: 'after' },
  );

  // returnDocument 'after' with upsert always yields a document.
  return res as UserRecord;
}

export async function findUser(uid: string): Promise<UserRecord | null> {
  const { users } = await collections();
  return users.findOne({ uid });
}
