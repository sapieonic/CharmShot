/**
 * NanoBananaProvider — the first concrete image provider.
 *
 * This is intentionally the ONLY place "Nano Banana" specifics live. It calls
 * the provider's HTTP API with retries + timeouts. The API key is resolved from
 * Secrets Manager (env fallback for local dev) and cached.
 *
 * The HTTP shape here is a reasonable, documented assumption for the Nano Banana
 * API; swap the request/response mapping if the real contract differs. Nothing
 * outside this file needs to change.
 */

import { config } from '../config/env';
import { resolveSecretValue } from '../aws/secrets';
import { Errors } from '../shared/errors';
import { Logger, rootLogger } from '../shared/logger';
import { withRetry } from '../shared/retry';
import type { GenerateImagesParams, GeneratedImage, ImageProvider } from './types';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

export class NanoBananaProvider implements ImageProvider {
  readonly id = 'nano-banana';
  readonly name = 'Nano Banana';

  private apiKey: string | null = null;
  private readonly baseUrl: string;
  private readonly log: Logger;

  constructor(opts?: { baseUrl?: string; apiKey?: string; logger?: Logger }) {
    this.baseUrl = opts?.baseUrl ?? config.providers.nanoBananaBaseUrl;
    this.apiKey = opts?.apiKey ?? null;
    this.log = (opts?.logger ?? rootLogger).child({ provider: this.id });
  }

  private async getApiKey(): Promise<string> {
    if (this.apiKey) return this.apiKey;
    this.apiKey = await resolveSecretValue({
      secretArn: config.providers.secretsArn,
      jsonKey: 'nanoBananaApiKey',
      envFallback: config.providers.nanoBananaApiKeyEnv,
      label: 'Nano Banana API key',
    });
    return this.apiKey;
  }

  async generateImages(params: GenerateImagesParams): Promise<GeneratedImage[]> {
    const apiKey = await this.getApiKey();

    const requestBody = {
      prompt: params.prompt,
      num_images: params.count,
      style: params.stylePreset,
      aspect_ratio: params.aspectRatio,
      ...(params.seed !== undefined ? { seed: params.seed } : {}),
      // Identity-preservation: send reference images as base64. Nano Banana uses
      // these to anchor facial identity/resemblance in the output.
      reference_images: params.referenceImages.map((r) => ({
        content_type: r.contentType,
        data_base64: r.data.toString('base64'),
      })),
    };

    return withRetry(
      async () => this.callApi(apiKey, requestBody, params.count),
      {
        maxAttempts: MAX_ATTEMPTS,
        baseDelayMs: 500,
        onRetry: (attempt, err) =>
          this.log.warn('Retrying Nano Banana request', { attempt, error: String(err) }),
      },
    );
  }

  private async callApi(
    apiKey: string,
    body: unknown,
    expectedCount: number,
  ): Promise<GeneratedImage[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}/v1/images/generate`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // 5xx / 429 are retryable; 4xx (except 429) are not.
        const retryable = res.status >= 500 || res.status === 429;
        const err = Errors.providerError(`Nano Banana returned ${res.status}`, { status: res.status, body: text });
        (err as { retryable?: boolean }).retryable = retryable;
        throw err;
      }

      const json = (await res.json()) as {
        images?: { data_base64: string; content_type?: string; seed?: number }[];
      };
      const images = json.images ?? [];
      if (images.length === 0) {
        throw Errors.providerError('Nano Banana returned no images');
      }

      return images.slice(0, expectedCount).map((img) => {
        const contentType = img.content_type ?? 'image/webp';
        return {
          data: Buffer.from(img.data_base64, 'base64'),
          contentType,
          extension: extensionFor(contentType),
          ...(img.seed !== undefined ? { seed: img.seed } : {}),
        };
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
    default:
      return 'webp';
  }
}
