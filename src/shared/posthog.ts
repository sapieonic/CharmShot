/**
 * PostHog client: server-side product analytics + LLM/AI observability.
 *
 * One long-lived client per process, created lazily the first time it's needed
 * and only when POSTHOG_ENABLED=true and an API key is configured. Every export
 * here is a safe no-op otherwise, so call sites never branch on config.
 *
 * The client keeps an internal queue and flushes asynchronously (flushAt /
 * flushInterval), so `capture` is non-blocking — the same contract the stdout
 * metrics had. Always call `shutdownPostHog()` on process exit so queued events
 * are flushed.
 *
 * Note: this module is imported by `metrics.ts` and `strategy.ts`. It uses
 * `rootLogger` for its own diagnostics; `logger.ts` does NOT import this module,
 * so there is no import cycle.
 */

import { PostHog } from 'posthog-node';
import { config } from '../config/env';
import { rootLogger } from './logger';

// `undefined` = not yet resolved, `null` = resolved-but-disabled.
let client: PostHog | null | undefined;

function getClient(): PostHog | null {
  if (client !== undefined) return client;

  const { enabled, apiKey, host, flushAt, flushIntervalMs } = config.posthog;
  if (!enabled || !apiKey) {
    client = null;
    return client;
  }

  // Construct inside a guard so a bad key/host can never turn an analytics call
  // into a failed request/job. On failure we disable (null) rather than retry
  // the throwing constructor on every subsequent call.
  try {
    client = new PostHog(apiKey, { host, flushAt, flushInterval: flushIntervalMs });
    rootLogger.info('PostHog analytics enabled', { host });
  } catch (err) {
    rootLogger.warn('Failed to initialise PostHog client; analytics disabled', { error: String(err) });
    client = null;
  }
  return client;
}

export interface CaptureOptions {
  /** Falls back to the configured system distinct id for backend events. */
  distinctId?: string;
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
}

/** Capture a product-analytics event. No-op unless PostHog is enabled. */
export function capture(event: string, opts: CaptureOptions = {}): void {
  const ph = getClient();
  if (!ph) return;
  try {
    ph.capture({
      distinctId: opts.distinctId ?? config.posthog.systemDistinctId,
      event,
      ...(opts.properties ? { properties: opts.properties } : {}),
      ...(opts.groups ? { groups: opts.groups } : {}),
    });
  } catch (err) {
    rootLogger.warn('Failed to capture PostHog event', { event, error: String(err) });
  }
}

export interface AiGenerationEvent {
  /** Identified user (uid). Falls back to the system distinct id. */
  distinctId?: string;
  /** Groups related generations into one trace (e.g. jobId). */
  traceId?: string;
  /** Concrete model that produced the output (e.g. gpt-image-1). */
  model: string;
  /** Provider/route id that served the request (e.g. openai, nano-banana). */
  provider: string;
  /** Wall-clock latency of the provider call, in milliseconds. */
  latencyMs: number;
  isError?: boolean;
  error?: string;
  /** Extra `$ai_*` or custom properties (e.g. count, presetId). */
  properties?: Record<string, unknown>;
  groups?: Record<string, string>;
}

/**
 * Emit a PostHog LLM-analytics `$ai_generation` event. PostHog uses the
 * `$ai_*` property convention; `$ai_latency` is in seconds. Image-generation
 * providers don't expose token counts, so we send what we have (model,
 * provider, latency, trace) and let callers add more via `properties`.
 *
 * Delegates to `capture` so client resolution, the system-distinct-id fallback,
 * and error handling live in one place.
 */
export function captureAiGeneration(ev: AiGenerationEvent): void {
  const properties: Record<string, unknown> = {
    $ai_provider: ev.provider,
    $ai_model: ev.model,
    $ai_latency: ev.latencyMs / 1000,
    ...(ev.traceId ? { $ai_trace_id: ev.traceId } : {}),
    ...(ev.isError ? { $ai_is_error: true } : {}),
    ...(ev.error ? { $ai_error: ev.error } : {}),
    ...(ev.properties ?? {}),
  };

  capture('$ai_generation', {
    ...(ev.distinctId ? { distinctId: ev.distinctId } : {}),
    properties,
    ...(ev.groups ? { groups: ev.groups } : {}),
  });
}

/** Flush and close the client. Safe to call when disabled (no-op). */
export async function shutdownPostHog(): Promise<void> {
  if (client) {
    try {
      await client.shutdown();
    } catch (err) {
      rootLogger.warn('PostHog shutdown error', { error: String(err) });
    }
  }
  // Mark resolved-but-closed (not `undefined`) so a late capture after shutdown
  // can't resurrect a new, never-flushed client.
  client = null;
}
