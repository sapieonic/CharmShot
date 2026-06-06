/**
 * CloudWatch metrics via the Embedded Metric Format (EMF).
 *
 * Writing EMF JSON to stdout lets CloudWatch automatically extract metrics from
 * the log stream without a synchronous PutMetricData call on the request path.
 * This keeps the hot path cheap while still surfacing:
 *   - jobs_created, jobs_succeeded, jobs_failed (counts)
 *   - provider_latency_ms (milliseconds)
 */

import { config } from '../config/env';
import { rootLogger } from './logger';

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
 * Emit a single metric in EMF format. Dimensions are kept low-cardinality on
 * purpose (e.g. provider id, status) — never put uid/jobId in dimensions.
 */
export function emitMetric(name: MetricName, value: number, opts: EmitOptions = {}): void {
  if (!config.metrics.enabled) return;

  const unit = opts.unit ?? UNIT_BY_METRIC[name];
  const dimensions = opts.dimensions ?? {};
  const dimensionKeys = Object.keys(dimensions);

  const emf = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: config.metrics.namespace,
          Dimensions: dimensionKeys.length > 0 ? [dimensionKeys] : [[]],
          Metrics: [{ Name: name, Unit: unit }],
        },
      ],
    },
    [name]: value,
    ...dimensions,
    ...(opts.properties ?? {}),
  };

  try {
    process.stdout.write(JSON.stringify(emf) + '\n');
  } catch (err) {
    rootLogger.warn('Failed to emit metric', { metric: name, error: String(err) });
  }
}

/** Times an async operation and emits provider_latency_ms with a provider dimension. */
export async function timeProvider<T>(provider: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    emitMetric('provider_latency_ms', Date.now() - start, { dimensions: { provider } });
  }
}
