import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The PostHog integration is gated behind POSTHOG_ENABLED + an API key and is a
 * complete no-op otherwise (the default in the test env). These tests cover both
 * the disabled no-op contract and the enabled path, mocking `posthog-node` so no
 * real client is constructed. `vi.resetModules()` + dynamic import lets each case
 * re-read `config` from a freshly-set environment.
 */

const { captureMock, shutdownMock, PostHogCtor } = vi.hoisted(() => {
  const capture = vi.fn();
  const shutdown = vi.fn().mockResolvedValue(undefined);
  return { captureMock: capture, shutdownMock: shutdown, PostHogCtor: vi.fn(() => ({ capture, shutdown })) };
});

vi.mock('posthog-node', () => ({ PostHog: PostHogCtor }));

describe('posthog (disabled — default test env)', () => {
  beforeEach(() => {
    vi.resetModules();
    PostHogCtor.mockClear();
    captureMock.mockClear();
  });

  it('does not construct a client or throw when disabled', async () => {
    const { capture, captureAiGeneration, shutdownPostHog } = await import('../../../src/shared/posthog');
    expect(() => capture('jobs_created', { properties: { value: 1 } })).not.toThrow();
    expect(() => captureAiGeneration({ model: 'nano-banana', provider: 'nano-banana', latencyMs: 10 })).not.toThrow();
    await expect(shutdownPostHog()).resolves.toBeUndefined();
    expect(PostHogCtor).not.toHaveBeenCalled();
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe('posthog (enabled)', () => {
  beforeEach(() => {
    vi.resetModules();
    PostHogCtor.mockClear();
    captureMock.mockClear();
    process.env.POSTHOG_ENABLED = 'true';
    process.env.POSTHOG_API_KEY = 'phc_test';
  });

  afterEach(() => {
    delete process.env.POSTHOG_ENABLED;
    delete process.env.POSTHOG_API_KEY;
  });

  it('capture forwards an event, defaulting to the system distinct id', async () => {
    const { capture } = await import('../../../src/shared/posthog');
    capture('jobs_created', { properties: { value: 1, model: 'nano-banana' } });
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'jobs_created',
        distinctId: 'charmshot-backend',
        properties: { value: 1, model: 'nano-banana' },
      }),
    );
  });

  it('capture uses the provided distinctId and groups', async () => {
    const { capture } = await import('../../../src/shared/posthog');
    capture('credits_reserved', { distinctId: 'user_1', groups: { company: 'acme' } });
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'credits_reserved', distinctId: 'user_1', groups: { company: 'acme' } }),
    );
  });

  it('constructs the client once across multiple captures', async () => {
    const { capture } = await import('../../../src/shared/posthog');
    capture('jobs_created');
    capture('jobs_succeeded');
    expect(PostHogCtor).toHaveBeenCalledTimes(1);
  });

  it('captureAiGeneration emits $ai_generation with latency in seconds', async () => {
    const { captureAiGeneration } = await import('../../../src/shared/posthog');
    captureAiGeneration({
      model: 'nano-banana',
      provider: 'nano-banana',
      latencyMs: 2000,
      distinctId: 'user_1',
      traceId: 'job_1',
      properties: { presetId: 'glow' },
    });
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: '$ai_generation',
        distinctId: 'user_1',
        properties: expect.objectContaining({
          $ai_provider: 'nano-banana',
          $ai_model: 'nano-banana',
          $ai_latency: 2,
          $ai_trace_id: 'job_1',
          presetId: 'glow',
        }),
      }),
    );
  });

  it('captureAiGeneration marks errors with $ai_is_error', async () => {
    const { captureAiGeneration } = await import('../../../src/shared/posthog');
    captureAiGeneration({ model: 'nano-banana', provider: 'nano-banana', latencyMs: 5, isError: true, error: 'boom' });
    expect(captureMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: '$ai_generation',
        properties: expect.objectContaining({ $ai_is_error: true, $ai_error: 'boom' }),
      }),
    );
  });

  it('shutdownPostHog flushes the client', async () => {
    const { capture, shutdownPostHog } = await import('../../../src/shared/posthog');
    capture('jobs_created');
    await shutdownPostHog();
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('does not resurrect the client after shutdown (no second construction)', async () => {
    const { capture, shutdownPostHog } = await import('../../../src/shared/posthog');
    capture('jobs_created');
    await shutdownPostHog();
    capture('jobs_succeeded'); // late event after shutdown
    expect(PostHogCtor).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing capture() so analytics never breaks the caller', async () => {
    captureMock.mockImplementationOnce(() => {
      throw new Error('network down');
    });
    const { capture } = await import('../../../src/shared/posthog');
    expect(() => capture('jobs_created')).not.toThrow();
  });

  it('contains a throwing constructor and disables analytics instead of propagating', async () => {
    PostHogCtor.mockImplementationOnce(() => {
      throw new Error('invalid api key');
    });
    const { capture } = await import('../../../src/shared/posthog');
    expect(() => capture('jobs_created')).not.toThrow();
    expect(captureMock).not.toHaveBeenCalled();
    // Subsequent calls must not retry the throwing constructor.
    expect(() => capture('jobs_succeeded')).not.toThrow();
    expect(PostHogCtor).toHaveBeenCalledTimes(1);
  });
});
