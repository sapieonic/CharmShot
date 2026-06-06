/**
 * Provider selection strategy.
 *
 * Decouples "which provider should run this job" from the job logic. Supports:
 *   - primary provider (explicit modelId or configured default)
 *   - fallback provider (tried if primary fails)
 *   - optional weighted routing (pick among providers by weight)
 *
 * The pipeline asks the strategy to execute generation; the strategy owns the
 * primary→fallback attempt sequence and reports which provider actually
 * produced the output.
 */

import { config } from '../config/env';
import { Logger, rootLogger } from '../shared/logger';
import { toAppError } from '../shared/errors';
import { timeProvider } from '../shared/metrics';
import { getModelProvider, hasModelProvider } from './factory';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from './types';

export interface ProviderExecutionResult {
  images: GeneratedImage[];
  providerUsed: string;
}

export interface WeightedRoute {
  modelId: string;
  weight: number;
}

export interface ChainOptions {
  /** Override the configured default primary model. */
  defaultModelId?: string;
  /** Override the configured fallback model. */
  fallbackModelId?: string;
}

/**
 * Resolve the ordered list of providers to attempt for a job.
 *
 * @param requestedModelId modelId from the request (optional)
 * @param opts overrides for default/fallback (used by tests; prod uses config)
 */
export function resolveProviderChain(requestedModelId?: string, opts: ChainOptions = {}): ImageProvider[] {
  const defaultModelId = opts.defaultModelId ?? config.providers.defaultModelId;
  const fallbackModelId = opts.fallbackModelId ?? config.providers.fallbackModelId;

  const chain: ImageProvider[] = [];
  const seen = new Set<string>();

  const add = (id?: string) => {
    if (!id || seen.has(id) || !hasModelProvider(id)) return;
    seen.add(id);
    chain.push(getModelProvider(id));
  };

  // Explicit request wins as primary, else configured default.
  add(requestedModelId ?? defaultModelId);
  // Configured fallback (if distinct and registered).
  add(fallbackModelId);

  if (chain.length === 0) {
    // Surface a clear error: requested model resolves to nothing registered.
    return [getModelProvider(requestedModelId ?? defaultModelId)];
  }
  return chain;
}

/** Weighted random selection among registered providers (optional routing). */
export function pickWeighted(routes: WeightedRoute[]): string {
  const valid = routes.filter((r) => hasModelProvider(r.modelId) && r.weight > 0);
  if (valid.length === 0) return config.providers.defaultModelId;
  const total = valid.reduce((sum, r) => sum + r.weight, 0);
  let pick = Math.random() * total;
  for (const route of valid) {
    pick -= route.weight;
    if (pick <= 0) return route.modelId;
  }
  return valid[valid.length - 1]!.modelId;
}

/**
 * Execute generation against the provider chain, falling back on failure.
 * Throws the last error if every provider fails.
 */
export async function executeWithStrategy(
  params: GenerateImagesParams,
  opts: { requestedModelId?: string; logger?: Logger } & ChainOptions = {},
): Promise<ProviderExecutionResult> {
  const log = (opts.logger ?? rootLogger).child({ component: 'strategy' });
  const chain = resolveProviderChain(opts.requestedModelId, {
    ...(opts.defaultModelId !== undefined ? { defaultModelId: opts.defaultModelId } : {}),
    ...(opts.fallbackModelId !== undefined ? { fallbackModelId: opts.fallbackModelId } : {}),
  });
  let lastErr: unknown;

  for (const provider of chain) {
    try {
      log.info('Attempting provider', { provider: provider.id });
      const images = await timeProvider(provider.id, () => provider.generateImages(params));
      return { images, providerUsed: provider.id };
    } catch (err) {
      lastErr = err;
      log.warn('Provider failed, trying next if available', {
        provider: provider.id,
        error: String(err),
      });
    }
  }
  throw toAppError(lastErr);
}
