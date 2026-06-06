/**
 * OpenAIProvider — image generation via OpenAI's Images API (gpt-image-1).
 *
 * This file is the ONLY place OpenAI specifics live; it speaks the real Images
 * API contract:
 *
 *   Identity-preserving (reference selfies present) → image *edits*:
 *     POST {baseUrl}/images/edits        (multipart/form-data)
 *     fields: model, prompt, n, size, quality?, output_format?, image[] (1..16 files)
 *
 *   No reference images → text-to-image *generation*:
 *     POST {baseUrl}/images/generations  (application/json)
 *     body: { model, prompt, n, size, quality?, output_format? }
 *
 *   header:  authorization: Bearer <openai api key>
 *   resp:    { data: [{ b64_json }] }   (gpt-image-1 always returns base64)
 *
 * Unlike Nano Banana, gpt-image-1 returns `n` images in a single call, so we
 * request all of a job's `count` images at once. The Images API has no `seed`
 * parameter, so a requested `seed` is ignored. `style`/`stylePreset` is expressed
 * through the prompt. `size` is derived from the job's aspect ratio (the model
 * supports a fixed set of sizes) unless OPENAI_IMAGE_SIZE pins it explicitly.
 */

import { config } from '../config/env';
import { Errors } from '../shared/errors';
import { Logger, rootLogger } from '../shared/logger';
import { withRetry } from '../shared/retry';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from './types';

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 3;
/** gpt-image-1 accepts at most 16 input images on the edits endpoint. */
const MAX_INPUT_IMAGES = 16;

/** Shape of the OpenAI Images API response (data carries base64 images). */
interface OpenAIImageResponse {
  data?: { b64_json?: string; url?: string }[];
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAIProvider implements ImageProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI';

  private apiKey: string | null = null;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly quality: string | undefined;
  private readonly outputFormat: string | undefined;
  private readonly sizeOverride: string | undefined;
  private readonly log: Logger;

  constructor(opts?: {
    baseUrl?: string;
    model?: string;
    quality?: string;
    outputFormat?: string;
    size?: string;
    apiKey?: string;
    logger?: Logger;
  }) {
    this.baseUrl = opts?.baseUrl ?? config.providers.openaiBaseUrl;
    this.model = opts?.model ?? config.providers.openaiModel;
    this.quality = opts?.quality ?? config.providers.openaiImageQuality;
    this.outputFormat = opts?.outputFormat ?? config.providers.openaiImageOutputFormat;
    this.sizeOverride = opts?.size ?? config.providers.openaiImageSize;
    this.apiKey = opts?.apiKey ?? null;
    this.log = (opts?.logger ?? rootLogger).child({ provider: this.id });
  }

  private getApiKey(): string {
    if (this.apiKey) return this.apiKey;
    if (!config.providers.openaiApiKey) {
      throw Errors.internal('OPENAI_API_KEY is not configured');
    }
    this.apiKey = config.providers.openaiApiKey;
    return this.apiKey;
  }

  async generateImages(params: GenerateImagesParams): Promise<GeneratedImage[]> {
    const apiKey = this.getApiKey();
    const count = Math.max(1, params.count);
    // gpt-image-1 returns `n` images per call — no fan-out needed.
    return withRetry(() => this.callApi(apiKey, params, count), {
      maxAttempts: MAX_ATTEMPTS,
      baseDelayMs: 500,
      onRetry: (attempt, err) =>
        this.log.warn('Retrying OpenAI image request', { attempt, error: String(err) }),
    });
  }

  private size(aspectRatio: string): string {
    return this.sizeOverride ?? sizeForAspectRatio(aspectRatio);
  }

  private async callApi(apiKey: string, params: GenerateImagesParams, count: number): Promise<GeneratedImage[]> {
    const useEdits = params.referenceImages.length > 0;
    const endpoint = useEdits ? 'images/edits' : 'images/generations';
    const headers: Record<string, string> = { authorization: `Bearer ${apiKey}` };

    let body: BodyInit;
    if (useEdits) {
      // Multipart: send reference selfies inline so the model anchors identity.
      const form = new FormData();
      form.append('model', this.model);
      form.append('prompt', params.prompt);
      form.append('n', String(count));
      form.append('size', this.size(params.aspectRatio));
      if (this.quality) form.append('quality', this.quality);
      if (this.outputFormat) form.append('output_format', this.outputFormat);
      params.referenceImages.slice(0, MAX_INPUT_IMAGES).forEach((ref, i) => {
        const ext = extensionFor(ref.contentType);
        form.append('image[]', new Blob([new Uint8Array(ref.data)], { type: ref.contentType }), `reference-${i}.${ext}`);
      });
      body = form; // fetch sets the multipart content-type (with boundary) itself.
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify({
        model: this.model,
        prompt: params.prompt,
        n: count,
        size: this.size(params.aspectRatio),
        ...(this.quality ? { quality: this.quality } : {}),
        ...(this.outputFormat ? { output_format: this.outputFormat } : {}),
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/${endpoint}`, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 5xx / 429 are retryable; other 4xx are deterministic and are not.
        const retryable = res.status >= 500 || res.status === 429;
        const err = Errors.providerError(`OpenAI returned ${res.status}`, { status: res.status, body: text });
        (err as { retryable?: boolean }).retryable = retryable;
        throw err;
      }

      const json = (await res.json()) as OpenAIImageResponse;
      const items = (json.data ?? []).filter((d) => d.b64_json);
      if (items.length === 0) {
        throw Errors.providerError(
          json.error?.message ? `OpenAI returned no image (${json.error.message})` : 'OpenAI returned no image data',
        );
      }

      const contentType = this.outputFormat ? `image/${normalizeFormat(this.outputFormat)}` : 'image/png';
      return items.map((d) => ({
        data: Buffer.from(d.b64_json!, 'base64'),
        contentType,
        extension: extensionFor(contentType),
      }));
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Map a "w:h" aspect ratio to one of gpt-image-1's supported sizes. The model
 * only offers square / landscape / portrait, so we bucket by orientation.
 */
function sizeForAspectRatio(aspectRatio: string): string {
  const m = /^\s*(\d+)\s*:\s*(\d+)\s*$/.exec(aspectRatio ?? '');
  if (!m) return 'auto';
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!w || !h || w === h) return '1024x1024';
  return w > h ? '1536x1024' : '1024x1536';
}

/** OpenAI uses "jpeg" for JPEG output; normalize so content types are valid. */
function normalizeFormat(format: string): string {
  const f = format.toLowerCase();
  return f === 'jpg' ? 'jpeg' : f;
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
    default:
      return 'png';
  }
}
