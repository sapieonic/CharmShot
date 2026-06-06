import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../../src/providers/openAiProvider';
import { config } from '../../../src/config/env';
import { AppError } from '../../../src/shared/errors';
import type { GenerateImagesParams } from '../../../src/providers/types';

const params: GenerateImagesParams = {
  referenceImages: [{ data: Buffer.from('ref'), contentType: 'image/jpeg' }],
  prompt: 'p',
  count: 2,
  stylePreset: 'casual-smart',
  aspectRatio: '4:5',
};

/** Build an OpenAI Images API response carrying `n` base64 images. */
function imageResponse(images: Buffer[], status = 200): Response {
  const body = { data: images.map((img) => ({ b64_json: img.toString('base64') })) };
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

function provider(): OpenAIProvider {
  return new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x', model: 'gpt-image-1' });
}

describe('OpenAIProvider identity', () => {
  it('exposes id (route) and model (concrete model) for observability', () => {
    const p = provider();
    expect(p.id).toBe('openai');
    expect(p.model).toBe('gpt-image-1');
  });
});

describe('OpenAIProvider.generateImages', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses the edits endpoint (multipart) with reference images and a bearer token', async () => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('png1'), Buffer.from('png2')]));
    vi.stubGlobal('fetch', fetchMock);

    const out = await provider().generateImages(params); // count: 2 → n=2 in one call

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x/images/edits');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer k');
    // multipart: fetch sets the content-type itself, we must not pin it.
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(init.body).toBeInstanceOf(FormData);

    const form = init.body as FormData;
    expect(form.get('model')).toBe('gpt-image-1');
    expect(form.get('prompt')).toBe('p');
    expect(form.get('n')).toBe('2');
    // 4:5 is portrait → 1024x1536.
    expect(form.get('size')).toBe('1024x1536');
    expect(form.getAll('image[]')).toHaveLength(1);

    expect(out).toHaveLength(2);
    expect(out[0]?.data.equals(Buffer.from('png1'))).toBe(true);
    expect(out[0]?.contentType).toBe('image/png');
    expect(out[0]?.extension).toBe('png');
  });

  it('uses the generations endpoint (JSON) when there are no reference images', async () => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('png')]));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generateImages({ ...params, referenceImages: [], count: 1, aspectRatio: '1:1' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://x/images/generations');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const sent = JSON.parse(init.body as string);
    expect(sent).toMatchObject({ model: 'gpt-image-1', prompt: 'p', n: 1, size: '1024x1024' });
  });

  it('sends quality and output_format when configured, and maps the content type', async () => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('jpg')]));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({
      apiKey: 'k',
      baseUrl: 'https://x',
      model: 'gpt-image-1',
      quality: 'high',
      outputFormat: 'jpeg',
    });
    const out = await p.generateImages({ ...params, count: 1 });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('quality')).toBe('high');
    expect(form.get('output_format')).toBe('jpeg');
    expect(out[0]?.contentType).toBe('image/jpeg');
    expect(out[0]?.extension).toBe('jpg');
  });

  it.each([
    ['1:1', '1024x1024'],
    ['16:9', '1536x1024'],
    ['9:16', '1024x1536'],
    ['3:4', '1024x1536'],
    ['', 'auto'],
    ['weird', 'auto'],
  ])('maps aspect ratio %s → size %s', async (aspectRatio, expected) => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('png')]));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generateImages({ ...params, count: 1, aspectRatio });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('size')).toBe(expected);
  });

  it('caps the number of reference images sent to the model at 16', async () => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('png')]));
    vi.stubGlobal('fetch', fetchMock);

    const refs = Array.from({ length: 20 }, () => ({ data: Buffer.from('ref'), contentType: 'image/png' }));
    await provider().generateImages({ ...params, count: 1, referenceImages: refs });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.getAll('image[]')).toHaveLength(16);
  });

  it('clamps a count below 1 up to a single image', async () => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('png')]));
    vi.stubGlobal('fetch', fetchMock);

    await provider().generateImages({ ...params, count: 0 });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('n')).toBe('1');
  });

  it('throws INTERNAL when no API key is configured', async () => {
    const original = config.providers.openaiApiKey;
    (config.providers as { openaiApiKey?: string }).openaiApiKey = undefined;
    try {
      // No apiKey injected → falls through to (empty) config.
      const p = new OpenAIProvider({ baseUrl: 'https://x', model: 'gpt-image-1' });
      const err = await p.generateImages({ ...params, count: 1 }).catch((e) => e);
      expect((err as AppError).code).toBe('INTERNAL');
      expect((err as Error).message).toMatch(/OPENAI_API_KEY/);
    } finally {
      (config.providers as { openaiApiKey?: string }).openaiApiKey = original;
    }
  });

  it('normalizes a "jpg" output format to "jpeg" on the wire and in the content type', async () => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('jpg')]));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x', model: 'm', outputFormat: 'jpg' });
    const out = await p.generateImages({ ...params, count: 1 });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('output_format')).toBe('jpeg');
    expect(out[0]?.contentType).toBe('image/jpeg');
    expect(out[0]?.extension).toBe('jpg');
  });

  it('honours an explicit size override regardless of aspect ratio', async () => {
    const fetchMock = vi.fn(async () => imageResponse([Buffer.from('png')]));
    vi.stubGlobal('fetch', fetchMock);

    const p = new OpenAIProvider({ apiKey: 'k', baseUrl: 'https://x', model: 'm', size: 'auto' });
    await p.generateImages({ ...params, count: 1 });

    const form = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(form.get('size')).toBe('auto');
  });

  it('retries on a 5xx then surfaces a PROVIDER_ERROR after exhausting attempts', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // 0ms backoff jitter, fast test
    const fetchMock = vi.fn(async () => errorResponse({ error: { message: 'boom' } }, 503));
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .generateImages({ ...params, count: 1 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(3); // MAX_ATTEMPTS
  });

  it('does NOT retry on a 4xx (e.g. 400)', async () => {
    const fetchMock = vi.fn(async () => errorResponse({ error: { message: 'bad' } }, 400));
    vi.stubGlobal('fetch', fetchMock);

    const err = await provider()
      .generateImages({ ...params, count: 1 })
      .catch((e) => e);
    expect((err as AppError).code).toBe('PROVIDER_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the response carries no image data', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = { data: [] };
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
