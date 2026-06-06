import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `emitMetric` has two sinks: a stdout `kind:"metric"` line (gated by
 * METRICS_ENABLED) and a PostHog event (gated by POSTHOG_ENABLED). The test env
 * disables both (see tests/setup.ts), so the default case is a full no-op. We
 * also verify the PostHog fan-out by mocking the PostHog module directly.
 */

const { capturePostHogMock } = vi.hoisted(() => ({ capturePostHogMock: vi.fn() }));
vi.mock('../../../src/shared/posthog', () => ({
  capture: capturePostHogMock,
  captureAiGeneration: vi.fn(),
}));

import { emitMetric } from '../../../src/shared/metrics';

describe('emitMetric (stdout disabled in test env)', () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => capturePostHogMock.mockClear());

  it('does not throw and writes nothing to stdout when METRICS_ENABLED=false', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(() => emitMetric('jobs_created', 1)).not.toThrow();
    expect(() => emitMetric('provider_latency_ms', 42, { dimensions: { provider: 'nano-banana' } })).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('emitMetric stdout line (METRICS_ENABLED=true)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.METRICS_ENABLED = 'true';
  });
  afterEach(() => {
    delete process.env.METRICS_ENABLED;
    vi.restoreAllMocks();
  });

  it('writes one kind:"metric" JSON line with namespace, value, unit, and dimensions', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const { emitMetric } = await import('../../../src/shared/metrics');
    emitMetric('provider_latency_ms', 1200, { dimensions: { provider: 'nano-banana' } });
    expect(write).toHaveBeenCalledTimes(1);
    const line = JSON.parse((write.mock.calls[0]![0] as string).trim());
    expect(line).toMatchObject({
      kind: 'metric',
      namespace: 'CharmShot',
      metric: 'provider_latency_ms',
      value: 1200,
      unit: 'Milliseconds',
      provider: 'nano-banana',
    });
    expect(typeof line.time).toBe('string');
  });
});

describe('emitMetric PostHog fan-out', () => {
  beforeEach(() => capturePostHogMock.mockClear());

  it('forwards the metric to PostHog as an event with value/unit/namespace', () => {
    emitMetric('jobs_created', 1, { dimensions: { model: 'nano-banana' } });
    expect(capturePostHogMock).toHaveBeenCalledTimes(1);
    expect(capturePostHogMock).toHaveBeenCalledWith(
      'jobs_created',
      expect.objectContaining({
        properties: expect.objectContaining({ value: 1, unit: 'Count', namespace: 'CharmShot', model: 'nano-banana' }),
      }),
    );
  });

  it('passes through distinctId for per-user attribution', () => {
    emitMetric('credits_reserved', 3, { distinctId: 'user_1' });
    expect(capturePostHogMock).toHaveBeenCalledWith('credits_reserved', expect.objectContaining({ distinctId: 'user_1' }));
  });

  it('omits distinctId for backend/system metrics', () => {
    emitMetric('rate_limited', 1);
    const opts = capturePostHogMock.mock.calls[0]![1];
    expect(opts).not.toHaveProperty('distinctId');
  });

  it('infers the metric unit (Milliseconds) when not given', () => {
    emitMetric('provider_latency_ms', 1200, { dimensions: { provider: 'nano-banana' } });
    expect(capturePostHogMock).toHaveBeenCalledWith(
      'provider_latency_ms',
      expect.objectContaining({ properties: expect.objectContaining({ value: 1200, unit: 'Milliseconds' }) }),
    );
  });
});
