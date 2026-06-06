/**
 * Centralised, typed access to environment configuration.
 *
 * This service runs as a long-lived server (not Lambda). All configuration —
 * including secrets — comes from environment variables (12-factor style). The
 * only external AWS dependency is S3; there is no Secrets Manager, SQS, or API
 * Gateway. For local development, load a .env file via your process manager or
 * `node --env-file=.env`.
 */

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function optStr(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return v.toLowerCase() === 'true' || v === '1';
}

export const config = {
  nodeEnv: optStr('NODE_ENV') ?? 'development',
  logLevel: optStr('LOG_LEVEL') ?? 'info',
  region: str('AWS_REGION', 'us-east-1'),

  server: {
    port: int('PORT', 8080),
    host: optStr('HOST') ?? '0.0.0.0',
    // Max JSON body size accepted by the HTTP server.
    bodyLimitBytes: int('BODY_LIMIT_BYTES', 1024 * 1024),
  },

  // In-process background worker that runs generation jobs.
  worker: {
    // How many generation jobs to process concurrently in this process.
    concurrency: int('WORKER_CONCURRENCY', 2),
    // Run the worker inside the API server process (single deployable).
    enabled: bool('WORKER_ENABLED', true),
  },

  mongo: {
    uri: str('MONGODB_URI', 'mongodb://localhost:27017'),
    dbName: str('MONGODB_DB_NAME', 'charmshot'),
  },

  s3: {
    uploadsBucket: str('UPLOADS_BUCKET', 'charmshot-uploads'),
    resultsBucket: str('RESULTS_BUCKET', 'charmshot-results'),
    uploadUrlTtlSeconds: int('UPLOAD_URL_TTL_SECONDS', 900),
    resultUrlTtlSeconds: int('RESULT_URL_TTL_SECONDS', 900),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
    // Optional custom endpoint (e.g. MinIO/LocalStack) for local development.
    endpoint: optStr('S3_ENDPOINT'),
    // Path-style addressing is required by most S3-compatible local servers.
    forcePathStyle: bool('S3_FORCE_PATH_STYLE', false),
  },

  firebase: {
    projectId: optStr('FIREBASE_PROJECT_ID') ?? 'charmshot-dev',
    // Full service-account JSON as a string. If unset, the Admin SDK verifies
    // ID tokens against Google's public JWKS using projectId alone.
    serviceAccountJson: optStr('FIREBASE_SERVICE_ACCOUNT_JSON'),
  },

  revenuecat: {
    // Expected value of the Authorization header on incoming webhooks.
    webhookAuth: optStr('REVENUECAT_WEBHOOK_AUTH'),
  },

  providers: {
    // "Nano Banana" is Google's nickname for the Gemini image models, served by
    // the Gemini API. The API key is a Google AI Studio / Gemini API key.
    // Default model is Nano Banana 2 = Gemini 3.1 Flash Image.
    nanoBananaApiKey: optStr('NANO_BANANA_API_KEY'),
    nanoBananaBaseUrl: optStr('NANO_BANANA_BASE_URL') ?? 'https://generativelanguage.googleapis.com/v1beta',
    nanoBananaModel: optStr('NANO_BANANA_MODEL') ?? 'gemini-3.1-flash-image-preview',
    // Optional output resolution for Nano Banana 2: "512", "1K", "2K", or "4K".
    // Left unset, the model picks its default (~1K).
    nanoBananaImageSize: optStr('NANO_BANANA_IMAGE_SIZE'),

    // OpenAI Images API (gpt-image-1). The API key is a standard OpenAI key.
    // When reference selfies are present we call the image *edits* endpoint for
    // identity preservation; otherwise text-to-image *generations*.
    openaiApiKey: optStr('OPENAI_API_KEY'),
    openaiBaseUrl: optStr('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1',
    openaiModel: optStr('OPENAI_IMAGE_MODEL') ?? 'gpt-image-1',
    // Optional gpt-image-1 quality: "low", "medium", "high", or "auto".
    openaiImageQuality: optStr('OPENAI_IMAGE_QUALITY'),
    // Optional output format: "png" (default), "jpeg", or "webp".
    openaiImageOutputFormat: optStr('OPENAI_IMAGE_OUTPUT_FORMAT'),
    // Optional fixed size ("1024x1024" | "1536x1024" | "1024x1536" | "auto").
    // Left unset, size is derived from the request's aspect ratio.
    openaiImageSize: optStr('OPENAI_IMAGE_SIZE'),

    defaultModelId: str('DEFAULT_MODEL_ID', 'nano-banana'),
    fallbackModelId: optStr('FALLBACK_MODEL_ID'),
  },

  credits: {
    freeTierCredits: int('FREE_TIER_CREDITS', 10),
    refundOnFailure: bool('REFUND_ON_FAILURE', true),
  },

  rateLimit: {
    windowSeconds: int('RATE_LIMIT_WINDOW_SECONDS', 60),
    maxRequests: int('RATE_LIMIT_MAX_REQUESTS', 60),
  },

  metrics: {
    namespace: str('METRICS_NAMESPACE', 'CharmShot'),
    enabled: bool('METRICS_ENABLED', true),
  },

  // PostHog: server-side product analytics, LLM/AI observability ($ai_generation),
  // and (via OpenTelemetry) log shipping. Everything is gated behind `enabled`
  // + an API key, so the whole integration is a no-op until configured.
  posthog: {
    enabled: bool('POSTHOG_ENABLED', false),
    // Project API key (starts with `phc_`). Required for any PostHog output.
    apiKey: optStr('POSTHOG_API_KEY'),
    // Ingestion host: https://us.i.posthog.com or https://eu.i.posthog.com (or self-hosted).
    host: optStr('POSTHOG_HOST') ?? 'https://us.i.posthog.com',
    // Client batching (non-blocking). Long-lived process, so defaults are fine.
    flushAt: int('POSTHOG_FLUSH_AT', 20),
    flushIntervalMs: int('POSTHOG_FLUSH_INTERVAL_MS', 10000),
    // distinct_id used for backend/system events that aren't tied to a user.
    systemDistinctId: optStr('POSTHOG_SYSTEM_DISTINCT_ID') ?? 'charmshot-backend',
    // Ship structured logs to PostHog Logs over OTLP/HTTP. Independent toggle so
    // analytics can run without log shipping (and vice versa).
    logsEnabled: bool('POSTHOG_LOGS_ENABLED', false),
    // OpenTelemetry resource service.name attached to shipped logs.
    serviceName: optStr('POSTHOG_SERVICE_NAME') ?? 'charmshot-api',
  },
} as const;

export type AppConfig = typeof config;
