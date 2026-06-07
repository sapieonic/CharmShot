/**
 * Lightweight application metrics.
 *
 * This service is not on Lambda/CloudWatch, so metrics are emitted as
 * structured JSON log lines (one per metric) to stdout. A log shipper
 * (Loki/ELK/Datadog/etc.) can parse `kind:"metric"` lines and turn them into
 * counters/timers. Keeping the same emit API means call sites are unchanged if
 * you later swap in a real metrics backend (StatsD, OTEL, Prometheus pushgw).
 *
 * Surfaced metrics:
 *   - jobs_created, jobs_succeeded, jobs_failed (counts)
 *   - provider_latency_ms (milliseconds)
 *   - credits_reserved, credits_refunded, rate_limited
 */

import { config } from '../config/env';
import { rootLogger } from './logger';
import { capture as capturePostHog } from './posthog';

export type MetricUnit = 'Count' | 'Milliseconds' | 'None';

export type MetricName =
  | 'jobs_created'
  | 'jobs_succeeded'
  | 'jobs_failed'
  | 'provider_latency_ms'
  | 'credits_reserved'
  | 'credits_refunded'
  | 'rate_limited';

interface EmitOptions {
  unit?: MetricUnit;
  dimensions?: Record<string, string>;
  properties?: Record<string, unknown>;
  /**
   * Identified user (uid) the metric belongs to, for PostHog. Backend/system
   * metrics omit this and are attributed to the configured system distinct id.
   */
  distinctId?: string;
}

const UNIT_BY_METRIC: Record<MetricName, MetricUnit> = {
  jobs_created: 'Count',
  jobs_succeeded: 'Count',
  jobs_failed: 'Count',
  provider_latency_ms: 'Milliseconds',
  credits_reserved: 'Count',
  credits_refunded: 'Count',
  rate_limited: 'Count',
};

/**
 * Emit a single metric as a structured log line. Dimensions are kept
 * low-cardinality on purpose (e.g. provider id, status) — never put uid/jobId
 * in dimensions.
 */
export function emitMetric(name: MetricName, value: number, opts: EmitOptions = {}): void {
  const unit = opts.unit ?? UNIT_BY_METRIC[name];

  if (config.metrics.enabled) {
    const line = {
      kind: 'metric',
      namespace: config.metrics.namespace,
      metric: name,
      value,
      unit,
      time: new Date().toISOString(),
      ...(opts.dimensions ?? {}),
      ...(opts.properties ?? {}),
    };

    try {
      process.stdout.write(JSON.stringify(line) + '\n');
    } catch (err) {
      rootLogger.warn('Failed to emit metric', { metric: name, error: String(err) });
    }
  }

  // Fan out to PostHog as a product-analytics event (no-op unless enabled).
  // PostHog has no raw metric ingestion, so each metric is an event; counters
  // and timers are built as Insights/Trends over `value`.
  capturePostHog(name, {
    ...(opts.distinctId ? { distinctId: opts.distinctId } : {}),
    properties: {
      value,
      unit,
      namespace: config.metrics.namespace,
      ...(opts.dimensions ?? {}),
      ...(opts.properties ?? {}),
    },
  });
}
