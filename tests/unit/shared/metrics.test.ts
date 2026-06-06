import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitMetric, timeProvider } from '../../../src/shared/metrics';

/**
 * The test environment sets METRICS_ENABLED=false (see tests/setup.ts), so
 * emitMetric is a no-op. These tests assert that contract: nothing is written
 * to stdout and nothing throws, while timeProvider still wraps the operation.
 */
describe('emitMetric (metrics disabled in test env)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not throw and writes nothing to stdout when disabled', () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(() => emitMetric('jobs_created', 1)).not.toThrow();
    expect(() => emitMetric('provider_latency_ms', 42, { dimensions: { provider: 'nano-banana' } })).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });
});

describe('timeProvider', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the wrapped value', async () => {
    const result = await timeProvider('nano-banana', async () => 'value');
    expect(result).toBe('value');
  });

  it('propagates errors from the wrapped function', async () => {
    await expect(
      timeProvider('nano-banana', async () => {
        throw new Error('provider failed');
      }),
    ).rejects.toThrow('provider failed');
  });

  it('still emits the latency metric (no-op while disabled) without writing', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await timeProvider('nano-banana', async () => 1);
    expect(write).not.toHaveBeenCalled();
  });
});
