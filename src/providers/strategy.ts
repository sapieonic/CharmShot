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
import { emitMetric } from '../shared/metrics';
import { captureAiGeneration } from '../shared/posthog';
import { recordSpanError, SpanKind, withSpan } from '../shared/tracing';
import { getModelProvider, hasModelProvider } from './factory';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from './types';

export interface ProviderExecutionResult {
  images: GeneratedImage[];
  providerUsed: string;
}

/** PostHog LLM-analytics context for a generation, threaded by the caller. */
export interface AiTracingContext {
  /** Identified user (uid). */
  distinctId?: string;
  /** Groups all attempts for this job into one trace (e.g. jobId). */
  traceId?: string;
  /** Extra `$ai_*`/custom properties (e.g. presetId, count). */
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
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
  opts: { requestedModelId?: string; logger?: Logger; ai?: AiTracingContext } & ChainOptions = {},
): Promise<ProviderExecutionResult> {
  const log = (opts.logger ?? rootLogger).child({ component: 'strategy' });
  const chain = resolveProviderChain(opts.requestedModelId, {
    ...(opts.defaultModelId !== undefined ? { defaultModelId: opts.defaultModelId } : {}),
    ...(opts.fallbackModelId !== undefined ? { fallbackModelId: opts.fallbackModelId } : {}),
  });
  let lastErr: unknown;

  // Per-user attribution for the latency metric in PostHog (stdout metric is
  // unaffected — distinctId is only used by the PostHog sink).
  const latencyOpts = opts.ai?.distinctId ? { distinctId: opts.ai.distinctId } : {};

  for (const provider of chain) {
    // One CLIENT span per attempt so a fallback shows up as a sibling span and
    // each provider's latency/outcome is visible in the trace. A failed attempt
    // is recorded but swallowed here so the loop can try the next provider.
    const attempt = await withSpan(
      'image.generate',
      async (span): Promise<{ images: GeneratedImage[] } | { error: unknown }> => {
        // Time each attempt once and emit both the latency metric and a PostHog
        // `$ai_generation` event (success or error) for LLM-analytics traces.
        const start = Date.now();
        try {
          log.info('Attempting provider', { provider: provider.id });
          const images = await provider.generateImages(params);
          const latencyMs = Date.now() - start;
          span.setAttribute('gen_ai.response.latency_ms', latencyMs);
          emitMetric('provider_latency_ms', latencyMs, { dimensions: { provider: provider.id }, ...latencyOpts });
          captureGeneration(provider, latencyMs, opts.ai);
          return { images };
        } catch (err) {
          const latencyMs = Date.now() - start;
          span.setAttribute('gen_ai.response.latency_ms', latencyMs);
          recordSpanError(span, err);
          emitMetric('provider_latency_ms', latencyMs, { dimensions: { provider: provider.id }, ...latencyOpts });
          captureGeneration(provider, latencyMs, opts.ai, err);
          log.warn('Provider failed, trying next if available', {
            provider: provider.id,
            error: String(err),
          });
          return { error: err };
        }
      },
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'gen_ai.system': provider.id,
          'gen_ai.request.model': provider.model,
          'gen_ai.operation.name': 'image.generate',
          'gen_ai.request.image_count': params.count,
          ...(params.stylePreset ? { 'gen_ai.request.style_preset': params.stylePreset } : {}),
        },
      },
    );

    if ('images' in attempt) {
      return { images: attempt.images, providerUsed: provider.id };
    }
    lastErr = attempt.error;
  }
  throw toAppError(lastErr);
}

/** Emit a `$ai_generation` event for one provider attempt (no-op if PostHog off). */
function captureGeneration(provider: ImageProvider, latencyMs: number, ai?: AiTracingContext, err?: unknown): void {
  captureAiGeneration({
    model: provider.model,
    provider: provider.id,
    latencyMs,
    ...(ai?.distinctId ? { distinctId: ai.distinctId } : {}),
    ...(ai?.traceId ? { traceId: ai.traceId } : {}),
    ...(ai?.properties ? { properties: ai.properties } : {}),
    ...(ai?.groups ? { groups: ai.groups } : {}),
    ...(err ? { isError: true, error: String(err) } : {}),
  });
}
