/**
 * AWS Secrets Manager access with in-process caching.
 *
 * Lambda execution contexts are reused, so caching avoids hitting Secrets
 * Manager on every invocation. Each secret is fetched once and memoised for the
 * lifetime of the container (with an optional TTL).
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { config } from '../config/env';
import { rootLogger } from '../shared/logger';

const client = new SecretsManagerClient({ region: config.region });

interface CacheEntry {
  value: string;
  fetchedAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry>();

/** Fetch a raw secret string by ARN (or name), cached. */
export async function getSecretString(arn: string): Promise<string> {
  const cached = cache.get(arn);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const res = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = res.SecretString ?? (res.SecretBinary ? Buffer.from(res.SecretBinary).toString('utf-8') : undefined);
  if (value === undefined) {
    throw new Error(`Secret ${arn} has no string value`);
  }
  cache.set(arn, { value, fetchedAt: Date.now() });
  return value;
}

/** Fetch and JSON.parse a secret. */
export async function getSecretJson<T = Record<string, unknown>>(arn: string): Promise<T> {
  const raw = await getSecretString(arn);
  return JSON.parse(raw) as T;
}

/**
 * Resolve a config value that may come either from a Secrets Manager JSON secret
 * (preferred in prod) or from an environment variable (local dev fallback).
 */
export async function resolveSecretValue(opts: {
  secretArn?: string;
  jsonKey?: string;
  envFallback?: string;
  label: string;
}): Promise<string> {
  if (opts.secretArn) {
    try {
      if (opts.jsonKey) {
        const json = await getSecretJson<Record<string, unknown>>(opts.secretArn);
        const v = json[opts.jsonKey];
        if (typeof v === 'string' && v.length > 0) return v;
        throw new Error(`Key '${opts.jsonKey}' missing in secret`);
      }
      return await getSecretString(opts.secretArn);
    } catch (err) {
      rootLogger.error(`Failed to resolve secret for ${opts.label}`, err);
      throw err;
    }
  }
  if (opts.envFallback && opts.envFallback.length > 0) return opts.envFallback;
  throw new Error(`No secret source configured for ${opts.label}`);
}

/** Test helper: clear the cache. */
export function _clearSecretCache(): void {
  cache.clear();
}
