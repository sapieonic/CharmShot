/**
 * Per-uid rate limiting using a fixed-window counter in MongoDB.
 *
 * A document per (uid, window) is atomically upserted+incremented; a TTL index
 * on expiresAt cleans up old windows. This is simple, correct under
 * concurrency, and requires no extra infrastructure beyond Mongo.
 */

import { collections } from '../db/mongo';
import { config } from '../config/env';
import { Errors } from '../shared/errors';
import { emitMetric } from '../shared/metrics';

export async function enforceRateLimit(uid: string): Promise<void> {
  const windowSeconds = config.rateLimit.windowSeconds;
  const max = config.rateLimit.maxRequests;
  if (max <= 0) return; // disabled

  const now = Date.now();
  const windowStart = Math.floor(now / (windowSeconds * 1000)) * windowSeconds;
  const id = `${uid}:${windowStart}`;
  const expiresAt = new Date((windowStart + windowSeconds * 2) * 1000);

  const { rateLimits } = await collections();
  const res = await rateLimits.findOneAndUpdate(
    { _id: id },
    {
      $inc: { count: 1 },
      $setOnInsert: { uid, windowStart, expiresAt },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const count = res?.count ?? 1;
  if (count > max) {
    emitMetric('rate_limited', 1);
    throw Errors.rateLimited(`Rate limit exceeded: ${max} requests per ${windowSeconds}s`, {
      retryAfterSeconds: windowSeconds,
    });
  }
}
