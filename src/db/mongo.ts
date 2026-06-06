/**
 * MongoDB connection management.
 *
 * The MongoClient is cached across Lambda invocations (module scope persists in
 * a warm container). We also ensure indexes once per process. The connection
 * URI is resolved from Secrets Manager in production, env var in local dev.
 */

import { MongoClient, type Collection, type Db } from 'mongodb';
import { config } from '../config/env';
import { rootLogger } from '../shared/logger';
import type {
  AuditLogRecord,
  EntitlementRecord,
  JobRecord,
  UserRecord,
  WebhookEventRecord,
} from '../shared/types';

export interface RateLimitRecord {
  _id: string; // `${uid}:${windowStart}`
  uid: string;
  windowStart: number;
  count: number;
  expiresAt: Date;
}

let clientPromise: Promise<MongoClient> | null = null;
let indexesEnsured = false;

export async function getClient(): Promise<MongoClient> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const client = new MongoClient(config.mongo.uri, {
        maxPoolSize: 10,
        retryWrites: true,
        serverSelectionTimeoutMS: 8000,
      });
      await client.connect();
      rootLogger.info('Connected to MongoDB', { db: config.mongo.dbName });
      return client;
    })().catch((err) => {
      // Reset so the next call retries instead of caching a rejected promise.
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

export async function getDb(): Promise<Db> {
  const client = await getClient();
  const db = client.db(config.mongo.dbName);
  if (!indexesEnsured) {
    await ensureIndexes(db);
    indexesEnsured = true;
  }
  return db;
}

export const Collections = {
  users: 'users',
  jobs: 'jobs',
  entitlements: 'entitlements',
  webhookEvents: 'webhook_events',
  auditLogs: 'audit_logs',
  rateLimits: 'rate_limits',
} as const;

export async function collections(): Promise<{
  users: Collection<UserRecord>;
  jobs: Collection<JobRecord>;
  entitlements: Collection<EntitlementRecord>;
  webhookEvents: Collection<WebhookEventRecord>;
  auditLogs: Collection<AuditLogRecord>;
  rateLimits: Collection<RateLimitRecord>;
}> {
  const db = await getDb();
  return {
    users: db.collection<UserRecord>(Collections.users),
    jobs: db.collection<JobRecord>(Collections.jobs),
    entitlements: db.collection<EntitlementRecord>(Collections.entitlements),
    webhookEvents: db.collection<WebhookEventRecord>(Collections.webhookEvents),
    auditLogs: db.collection<AuditLogRecord>(Collections.auditLogs),
    rateLimits: db.collection<RateLimitRecord>(Collections.rateLimits),
  };
}

async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    db.collection(Collections.users).createIndex({ uid: 1 }, { unique: true }),
    db.collection(Collections.jobs).createIndex({ jobId: 1 }, { unique: true }),
    db.collection(Collections.jobs).createIndex({ uid: 1, createdAt: -1 }),
    db.collection(Collections.entitlements).createIndex({ uid: 1 }, { unique: true }),
    db.collection(Collections.webhookEvents).createIndex({ eventId: 1 }, { unique: true }),
    db.collection(Collections.auditLogs).createIndex({ uid: 1, createdAt: -1 }),
    // TTL index so rate-limit windows self-expire.
    db.collection(Collections.rateLimits).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
  ]);
  rootLogger.info('MongoDB indexes ensured');
}

/** Closes the cached client (used in tests / graceful shutdown). */
export async function closeClient(): Promise<void> {
  if (clientPromise) {
    const client = await clientPromise;
    await client.close();
    clientPromise = null;
    indexesEnsured = false;
  }
}
