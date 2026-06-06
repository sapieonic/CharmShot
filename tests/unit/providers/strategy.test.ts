import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetRegistry, registerModelProvider } from '../../../src/providers/factory';
import { pickWeighted, resolveProviderChain } from '../../../src/providers/strategy';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from '../../../src/providers/types';

function fakeProvider(id: string): ImageProvider {
  return {
    id,
    name: id,
    async generateImages(_p: GenerateImagesParams): Promise<GeneratedImage[]> {
      return [{ data: Buffer.from(id), contentType: 'image/webp', extension: 'webp' }];
    },
  };
}

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
