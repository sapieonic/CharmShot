/**
 * Provider abstraction for image generation.
 *
 * Job orchestration depends ONLY on this interface — never on a concrete
 * provider. New providers (e.g. another diffusion model) are added by
 * implementing ImageProvider and registering it in the factory; no changes to
 * the worker or generation service are required.
 */

export interface ReferenceImage {
  /** Raw image bytes fetched from S3. */
  data: Buffer;
  contentType: string;
  /** Original S3 key, for provider-side logging/traceability. */
  sourceKey?: string;
}

export interface GeneratedImage {
  /** Raw bytes of the generated image. */
  data: Buffer;
  contentType: string;
  /** File extension to use when persisting (e.g. "webp", "png"). */
  extension: string;
  /** Optional seed the provider actually used, for reproducibility. */
  seed?: number;
}

export interface GenerateImagesParams {
  referenceImages: ReferenceImage[];
  prompt: string;
  count: number;
  stylePreset: string;
  aspectRatio: string;
  seed?: number;
}

export interface ImageProvider {
  /** Stable identifier used by the factory and persisted as providerUsed. */
  readonly id: string;
  /** Human-readable name. */
  readonly name: string;
  /**
   * Concrete model identifier the provider actually calls (e.g. "gpt-image-1",
   * "gemini-3.1-flash-image-preview"). Reported to observability as the model,
   * distinct from `id` (the provider/route). Defaults to `id` if a provider has
   * no separate model concept.
   */
  readonly model: string;

  generateImages(params: GenerateImagesParams): Promise<GeneratedImage[]>;
}
