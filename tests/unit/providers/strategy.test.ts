import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRegistry, registerModelProvider } from '../../../src/providers/factory';
import { executeWithStrategy, pickWeighted, resolveProviderChain } from '../../../src/providers/strategy';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from '../../../src/providers/types';

const { captureAiGenerationMock } = vi.hoisted(() => ({ captureAiGenerationMock: vi.fn() }));
vi.mock('../../../src/shared/posthog', () => ({
  capture: vi.fn(),
  captureAiGeneration: captureAiGenerationMock,
}));

function fakeProvider(id: string, model = `${id}-model`): ImageProvider {
  return {
    id,
    name: id,
    model,
    async generateImages(_p: GenerateImagesParams): Promise<GeneratedImage[]> {
      return [{ data: Buffer.from(id), contentType: 'image/webp', extension: 'webp' }];
    },
  };
}

function failingProvider(id: string, model = `${id}-model`): ImageProvider {
  return {
    id,
    name: id,
    model,
    async generateImages(): Promise<GeneratedImage[]> {
      throw new Error(`${id} failed`);
    },
  };
}

const params: GenerateImagesParams = {
  referenceImages: [],
  prompt: 'p',
  count: 1,
  stylePreset: 'glow',
  aspectRatio: '1:1',
};

describe('resolveProviderChain', () => {
  beforeEach(() => _resetRegistry());
  afterEach(() => _resetRegistry());

  it('dedupes when the primary and fallback resolve to the same id', () => {
    registerModelProvider('same', fakeProvider('same'));
    const chain = resolveProviderChain('same', { defaultModelId: 'same', fallbackModelId: 'same' });
    expect(chain.map((p) => p.id)).toEqual(['same']);
  });

  it('honours explicit defaultModelId and fallbackModelId overrides', () => {
    registerModelProvider('def', fakeProvider('def'));
    registerModelProvider('fb', fakeProvider('fb'));
    const chain = resolveProviderChain(undefined, { defaultModelId: 'def', fallbackModelId: 'fb' });
    expect(chain.map((p) => p.id)).toEqual(['def', 'fb']);
  });

  it('puts the explicitly requested model first, then the configured fallback', () => {
    registerModelProvider('req', fakeProvider('req'));
    registerModelProvider('fb', fakeProvider('fb'));
    const chain = resolveProviderChain('req', { defaultModelId: 'def', fallbackModelId: 'fb' });
    expect(chain.map((p) => p.id)).toEqual(['req', 'fb']);
  });

  it('skips an unregistered fallback', () => {
    registerModelProvider('def', fakeProvider('def'));
    const chain = resolveProviderChain(undefined, { defaultModelId: 'def', fallbackModelId: 'missing' });
    expect(chain.map((p) => p.id)).toEqual(['def']);
  });
});

describe('executeWithStrategy AI tracing', () => {
  beforeEach(() => {
    _resetRegistry();
    captureAiGenerationMock.mockClear();
  });
  afterEach(() => _resetRegistry());

  it('emits a $ai_generation with the real model name (not the provider id) and trace context', async () => {
    // Provider id "def" but concrete model "gpt-image-1" — the event must carry
    // the model for PostHog LLM-analytics breakdowns, with provider = the route.
    registerModelProvider('def', fakeProvider('def', 'gpt-image-1'));
    const result = await executeWithStrategy(params, {
      defaultModelId: 'def',
      ai: { distinctId: 'user_1', traceId: 'job_1', properties: { presetId: 'glow' } },
    });
    expect(result.providerUsed).toBe('def');
    expect(captureAiGenerationMock).toHaveBeenCalledTimes(1);
    expect(captureAiGenerationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-image-1',
        provider: 'def',
        distinctId: 'user_1',
        traceId: 'job_1',
        properties: { presetId: 'glow' },
      }),
    );
    expect(captureAiGenerationMock.mock.calls[0]![0]).not.toHaveProperty('isError');
  });

  it('emits an errored $ai_generation per failed attempt then succeeds on fallback', async () => {
    registerModelProvider('primary', failingProvider('primary'));
    registerModelProvider('fb', fakeProvider('fb'));
    const result = await executeWithStrategy(params, {
      defaultModelId: 'primary',
      fallbackModelId: 'fb',
      ai: { distinctId: 'user_1' },
    });
    expect(result.providerUsed).toBe('fb');
    expect(captureAiGenerationMock).toHaveBeenCalledTimes(2);
    expect(captureAiGenerationMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ provider: 'primary', isError: true, error: expect.stringContaining('primary failed') }),
    );
    expect(captureAiGenerationMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ provider: 'fb' }));
  });
});

describe('pickWeighted', () => {
  beforeEach(() => _resetRegistry());
  afterEach(() => {
    _resetRegistry();
    vi.restoreAllMocks();
  });

  it('ignores zero/negative weights and unregistered ids', () => {
    registerModelProvider('a', fakeProvider('a'));
    registerModelProvider('b', fakeProvider('b'));
    // Only "a" is valid: b has weight 0, c is unregistered.
    for (let i = 0; i < 50; i++) {
      const picked = pickWeighted([
        { modelId: 'a', weight: 5 },
        { modelId: 'b', weight: 0 },
        { modelId: 'c', weight: 100 },
      ]);
      expect(picked).toBe('a');
    }
  });

  it('returns the configured default model when no route is valid', () => {
    // Registry empty -> nothing valid -> default model id from config.
    const picked = pickWeighted([
      { modelId: 'x', weight: 10 },
      { modelId: 'y', weight: -1 },
    ]);
    expect(picked).toBe('nano-banana');
  });

  it('selects deterministically given a stubbed Math.random', () => {
    registerModelProvider('a', fakeProvider('a'));
    registerModelProvider('b', fakeProvider('b'));
    const routes = [
      { modelId: 'a', weight: 1 },
      { modelId: 'b', weight: 9 },
    ];
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // 0.5 * 10 = 5 -> lands in b's range
    expect(pickWeighted(routes)).toBe('b');
    vi.spyOn(Math, 'random').mockReturnValue(0.0); // start -> a
    expect(pickWeighted(routes)).toBe('a');
  });
});
