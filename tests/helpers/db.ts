/**
 * Integration-test database helpers.
 *
 * Integration tests run against a REAL MongoDB reached via MONGODB_URI (set in
 * tests/setup.ts, default mongodb://localhost:27017). To keep the suite green
 * on machines without a MongoDB, we probe availability once at module load and
 * export `mongoAvailable`; suites gate themselves with `describe.skipIf`.
 *
 * In CI a `mongo` service container is provided, so the probe succeeds and the
 * tests execute for real.
 */

import { MongoClient } from 'mongodb';
import { config } from '../../src/config/env';
import { Collections, closeClient, getDb } from '../../src/db/mongo';

/** Independent, short-timeout probe so we don't poison the app's cached client. */
async function probeMongo(): Promise<boolean> {
  const uri = config.mongo.uriEnv ?? 'mongodb://localhost:27017';
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500, connectTimeoutMS: 1500 });
  try {
    await client.connect();
    await client.db(config.mongo.dbName).command({ ping: 1 });
    return true;
  } catch {
    return false;
  } finally {
    await client.close().catch(() => undefined);
  }
}

// Top-level await: vitest supports ESM TLA in modules. Resolved before suites
// are collected, so `describe.skipIf(!mongoAvailable)` works synchronously.
export const mongoAvailable: boolean = await probeMongo();

if (!mongoAvailable) {
  // eslint-disable-next-line no-console
  console.warn(
    `[integration] MongoDB not reachable at ${config.mongo.uriEnv ?? 'mongodb://localhost:27017'} — integration suites will be skipped. Set up a local MongoDB or run in CI.`,
  );
}

/** Drop all known application collections so each test starts clean. */
export async function clearCollections(): Promise<void> {
  const db = await getDb();
  await Promise.all(
    Object.values(Collections).map(async (name) => {
      await db.collection(name).deleteMany({});
    }),
  );
}

export async function getTestDb() {
  return getDb();
}

export async function closeTestDb(): Promise<void> {
  await closeClient();
}
