/**
 * NanoBananaProvider — image generation via Google's "Nano Banana".
 *
 * "Nano Banana" is Google's nickname for its Gemini image models, served by the
 * Gemini API. We default to Nano Banana 2 (Gemini 3.1 Flash Image); the model
 * id is configurable via NANO_BANANA_MODEL. This file is the ONLY place those
 * specifics live; it speaks the real Gemini `generateContent` contract:
 *
 *   POST {baseUrl}/models/{model}:generateContent
 *   header:  x-goog-api-key: <gemini api key>
 *   body:    { contents: [{ parts: [{ text }, { inline_data:{ mime_type, data }}] }],
 *              generationConfig: { responseModalities: ["IMAGE"],
 *                                  imageConfig: { aspectRatio, imageSize } } }
 *   resp:    { candidates: [{ content: { parts: [{ inlineData:{ mimeType, data }}] }}] }
 *
 * `imageSize` ("512"/"1K"/"2K"/"4K") is a Nano Banana 2 feature and is sent only
 * when configured. The model returns a single image per call, so to satisfy a
 * job's `count` we fan out `count` requests in parallel. The Gemini image API
 * has no `style` or `seed` parameters; style is expressed through the prompt,
 * and `seed` from the request is ignored (not supported by the model).
 */

import { config } from '../config/env';
import { Errors } from '../shared/errors';
import { Logger, rootLogger } from '../shared/logger';
import { withRetry } from '../shared/retry';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from './types';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

/** Shape of the Gemini inline-data blob (REST returns camelCase). */
interface GeminiInlineData {
  mimeType?: string;
  data?: string;
}
interface GeminiPart {
  inlineData?: GeminiInlineData;
  text?: string;
}
interface GeminiResponse {
  candidates?: { content?: { parts?: GeminiPart[] } }[];
  promptFeedback?: { blockReason?: string };
}

export class NanoBananaProvider implements ImageProvider {
  readonly id = 'nano-banana';
  readonly name = 'Nano Banana';

  private apiKey: string | null = null;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly imageSize: string | undefined;
  private readonly log: Logger;

  constructor(opts?: { baseUrl?: string; model?: string; imageSize?: string; apiKey?: string; logger?: Logger }) {
    this.baseUrl = opts?.baseUrl ?? config.providers.nanoBananaBaseUrl;
    this.model = opts?.model ?? config.providers.nanoBananaModel;
    this.imageSize = opts?.imageSize ?? config.providers.nanoBananaImageSize;
    this.apiKey = opts?.apiKey ?? null;
    this.log = (opts?.logger ?? rootLogger).child({ provider: this.id });
  }

  private async getApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    if (!config.providers.nanoBananaApiKey) {
      throw Errors.internal('NANO_BANANA_API_KEY is not configured');
    }
    this.apiKey = config.providers.nanoBananaApiKey;
    return this.apiKey;
  }

  async generateImages(params: GenerateImagesParams): Promise<GeneratedImage[]> {
    const apiKey = await this.getApiKey();
    const requestBody = this.buildRequest(params);
    const count = Math.max(1, params.count);

    // Gemini returns one image per call; fan out `count` requests in parallel.
    // Each call is retried independently; if any call ultimately fails the whole
    // batch rejects, letting the strategy fall back to another provider.
    return Promise.all(
      Array.from({ length: count }, (_unused, index) =>
        withRetry(() => this.callApi(apiKey, requestBody), {
          maxAttempts: MAX_ATTEMPTS,
          baseDelayMs: 500,
          onRetry: (attempt, err) =>
            this.log.warn('Retrying Nano Banana request', { index, attempt, error: String(err) }),
        }),
      ),
    );
  }

  /** Build the Gemini `generateContent` request body for one image. */
  private buildRequest(params: GenerateImagesParams): unknown {
    const parts: unknown[] = [{ text: params.prompt }];
    // Identity-preservation: send reference images inline so Gemini anchors
    // facial identity/resemblance in the output.
    for (const ref of params.referenceImages) {
      parts.push({ inline_data: { mime_type: ref.contentType, data: ref.data.toString('base64') } });
    }
    const imageConfig: Record<string, string> = {};
    if (params.aspectRatio) imageConfig.aspectRatio = params.aspectRatio;
    if (this.imageSize) imageConfig.imageSize = this.imageSize;
    return {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
      },
    };
  }

  private async callApi(apiKey: string, body: unknown): Promise<GeneratedImage> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/models/${this.model}:generateContent`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 5xx / 429 are retryable; other 4xx are deterministic and are not.
        const retryable = res.status >= 500 || res.status === 429;
        const err = Errors.providerError(`Nano Banana returned ${res.status}`, { status: res.status, body: text });
        (err as { retryable?: boolean }).retryable = retryable;
        throw err;
      }

      const json = (await res.json()) as GeminiResponse;
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      const inline = parts.find((p) => p.inlineData?.data)?.inlineData;
      if (!inline?.data) {
        const blockReason = json.promptFeedback?.blockReason;
        throw Errors.providerError(
          blockReason
            ? `Nano Banana returned no image (blocked: ${blockReason})`
            : 'Nano Banana returned no image data',
        );
      }

      const contentType = inline.mimeType ?? 'image/png';
      return {
        data: Buffer.from(inline.data, 'base64'),
        contentType,
        extension: extensionFor(contentType),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
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
