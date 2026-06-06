import { afterEach, describe, expect, it, vi } from 'vitest';
import { NanoBananaProvider } from '../../../src/providers/nanoBananaProvider';
import { AppError } from '../../../src/shared/errors';
import type { GenerateImagesParams } from '../../../src/providers/types';

const params: GenerateImagesParams = {
  referenceImages: [{ data: Buffer.from('ref'), contentType: 'image/jpeg' }],
  prompt: 'p',
  count: 2,
  stylePreset: 'casual-smart',
  aspectRatio: '4:5',
};

/** Build a Gemini `generateContent` style response carrying one inline image. */
function geminiResponse(image: { data: Buffer; mimeType?: string }, status = 200): Response {
  const part = image.mimeType
    ? { inlineData: { mimeType: image.mimeType, data: image.data.toString('base64') } }
    : { inlineData: { data: image.data.toString('base64') } };
  const body = { candidates: [{ content: { parts: [part] } }] };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errorResponse(body: unknown, status: number): Response {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function provider(): NanoBananaProvider {
  return new NanoBananaProvider({ apiKey: 'k', baseUrl: 'https://x', model: 'gemini-3.1-flash-image-preview' });
}

describe('NanoBananaProvider.generateImages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('calls the Gemini generateContent endpoint with the api key + image config', async () => {
    const fetchMock = vi.fn(async () => geminiResponse({ data: Buffer.from('png'), mimeType: 'image/png' }));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generateImages({ ...params, count: 1 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x/models/gemini-3.1-flash-image-preview:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('k');
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();

    const sent = JSON.parse(init.body as string);
    expect(sent.contents[0].parts[0]).toEqual({ text: 'p' });
    expect(sent.contents[0].parts[1].inline_data).toEqual({
      mime_type: 'image/jpeg',
      data: Buffer.from('ref').toString('base64'),
    });
    expect(sent.generationConfig.responseModalities).toEqual(['IMAGE']);
    expect(sent.generationConfig.imageConfig.aspectRatio).toBe('4:5');
    // imageSize is omitted unless explicitly configured.
    expect(sent.generationConfig.imageConfig.imageSize).toBeUndefined();
  });

  it('sends imageConfig.imageSize when configured (Nano Banana 2 resolution)', async () => {
    const fetchMock = vi.fn(async () => geminiResponse({ data: Buffer.from('png'), mimeType: 'image/png' }));
    vi.stubGlobal('fetch', fetchMock);

    const p = new NanoBananaProvider({ apiKey: 'k', baseUrl: 'https://x', model: 'm', imageSize: '4K' });
    await p.generateImages({ ...params, count: 1 });

    const sent = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(sent.generationConfig.imageConfig.imageSize).toBe('4K');
  });

  it('fans out one request per image and maps candidates → Buffers', async () => {
    const png = Buffer.from('pngbytes');
    const fetchMock = vi.fn(async () => geminiResponse({ data: png, mimeType: 'image/png' }));
    vi.stubGlobal('fetch', fetchMock);

    const out = await provider().generateImages(params); // count: 2
    expect(fetchMock).toHaveBeenCalledTimes(2); // one call per requested image
    expect(out).toHaveLength(2);
    expect(out[0]?.data.equals(png)).toBe(true);
    expect(out[0]?.contentType).toBe('image/png');
    expect(out[0]?.extension).toBe('png');
  });

  it('defaults the content type to png when the response omits mimeType', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiResponse({ data: Buffer.from('x') })));
    const out = await provider().generateImages({ ...params, count: 1 });
    expect(out[0]?.contentType).toBe('image/png');
    expect(out[0]?.extension).toBe('png');
  });

  it('retries on a 5xx then surfaces a PROVIDER_ERROR after exhausting attempts', async () => {
    // Math.random()=0 -> jitter backoff delay is 0ms, keeping the test fast.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetchMock = vi.fn(async () => errorResponse({ message: 'boom' }, 503));
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .generateImages({ ...params, count: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS
  });

  it('does NOT retry on a 4xx (e.g. 400)', async () => {
    const fetchMock = vi.fn(async () => errorResponse({ message: 'bad' }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .generateImages({ ...params, count: 1 })
      .catch((e) => e);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when a candidate carries no inline image data', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = { candidates: [{ content: { parts: [{ text: 'no image' }] } }] };
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      }),
    );
    const err = await provider()
      .generateImages({ ...params, count: 1 })
      .catch((e) => e);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect((err as Error).message).toMatch(/no image/i);
  });
});
