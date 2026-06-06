import { afterEach, describe, expect, it, vi } from 'vitest';
import { NanoBananaProvider } from '../../../src/providers/nanoBananaProvider';
import { AppError } from '../../../src/shared/errors';
import type { GenerateImagesParams } from '../../../src/providers/types';

const params: GenerateImagesParams = {
  referenceImages: [{ data: Buffer.from('ref'), contentType: 'image/jpeg' }],
  prompt: 'p',
  count: 2,
  stylePreset: 'casual-smart',
  aspectRatio: '1:1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function provider(): NanoBananaProvider {
  return new NanoBananaProvider({ apiKey: 'k', baseUrl: 'https://x' });
}

describe('NanoBananaProvider.generateImages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('maps base64 images to Buffers with the extension derived from content_type', async () => {
    const png = Buffer.from('pngbytes');
    const jpg = Buffer.from('jpgbytes');
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        images: [
          { data_base64: png.toString('base64'), content_type: 'image/png', seed: 11 },
          { data_base64: jpg.toString('base64'), content_type: 'image/jpeg' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const out = await provider().generateImages(params);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://x/v1/images/generate');
    expect(out).toHaveLength(2);
    expect(out[0]?.data.equals(png)).toBe(true);
    expect(out[0]?.extension).toBe('png');
    expect(out[0]?.seed).toBe(11);
    expect(out[1]?.extension).toBe('jpg');
  });

  it('defaults the extension to webp when content_type is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ images: [{ data_base64: Buffer.from('x').toString('base64') }] })),
    );
    const out = await provider().generateImages({ ...params, count: 1 });
    expect(out[0]?.contentType).toBe('image/webp');
    expect(out[0]?.extension).toBe('webp');
  });

  it('retries on a 5xx then surfaces a PROVIDER_ERROR after exhausting attempts', async () => {
    // Math.random()=0 -> jitter backoff delay is 0ms, keeping the test fast.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'boom' }, 503));
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .generateImages(params)
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS
  });

  it('does NOT retry on a 4xx (e.g. 400)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ message: 'bad' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .generateImages(params)
      .catch((e) => e);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the provider returns an empty images array', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ images: [] })));
    const err = await provider()
      .generateImages(params)
      .catch((e) => e);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect((err as Error).message).toMatch(/no images/i);
  });
});
