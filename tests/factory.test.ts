import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetRegistry,
  getModelProvider,
  hasModelProvider,
  listModelIds,
  registerModelProvider,
} from '../src/providers/factory';
import { executeWithStrategy, pickWeighted, resolveProviderChain } from '../src/providers/strategy';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from '../src/providers/types';

function fakeProvider(id: string, behaviour: 'ok' | 'fail'): ImageProvider {
  return {
    id,
    name: id,
    async generateImages(_p: GenerateImagesParams): Promise<GeneratedImage[]> {
      if (behaviour === 'fail') throw new Error(`${id} failed`);
      return [{ data: Buffer.from(id), contentType: 'image/webp', extension: 'webp' }];
    },
  };
}

const params: GenerateImagesParams = {
  referenceImages: [],
  prompt: 'p',
  count: 1,
  stylePreset: 'casual-smart',
  aspectRatio: '1:1',
};

describe('model factory', () => {
  beforeEach(() => {
    _resetRegistry();
  });
  afterEach(() => {
    _resetRegistry();
  });

  it('registers and resolves a provider by id', () => {
    const p = fakeProvider('nano-banana', 'ok');
    registerModelProvider('nano-banana', p);
    expect(hasModelProvider('nano-banana')).toBe(true);
    expect(getModelProvider('nano-banana')).toBe(p);
    expect(listModelIds()).toContain('nano-banana');
  });

  it('throws INVALID_INPUT for an unknown modelId', () => {
    expect(() => getModelProvider('does-not-exist')).toThrowError(/Unknown modelId/);
  });

  it('selects the requested model as primary in the chain', () => {
    registerModelProvider('nano-banana', fakeProvider('nano-banana', 'ok'));
    registerModelProvider('other', fakeProvider('other', 'ok'));
    const chain = resolveProviderChain('other');
    expect(chain[0]?.id).toBe('other');
  });

  it('falls back to the next provider when the primary fails', async () => {
    registerModelProvider('primary', fakeProvider('primary', 'fail'));
    registerModelProvider('fallback', fakeProvider('fallback', 'ok'));

    const result = await executeWithStrategy(params, {
      requestedModelId: 'primary',
      fallbackModelId: 'fallback',
    });
    expect(result.providerUsed).toBe('fallback');
    expect(result.images).toHaveLength(1);
  });

  it('throws when every provider in the chain fails', async () => {
    registerModelProvider('primary', fakeProvider('primary', 'fail'));
    await expect(executeWithStrategy(params, { requestedModelId: 'primary' })).rejects.toThrow();
  });

  it('weighted routing only picks registered providers', () => {
    registerModelProvider('a', fakeProvider('a', 'ok'));
    const picked = pickWeighted([
      { modelId: 'a', weight: 10 },
      { modelId: 'unregistered', weight: 90 },
    ]);
    expect(picked).toBe('a');
  });
});
