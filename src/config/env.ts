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
    nanoBananaApiKey: optStr('NANO_BANANA_API_KEY'),
    nanoBananaBaseUrl: optStr('NANO_BANANA_BASE_URL') ?? 'https://api.nanobanana.example.com',
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
} as const;

export type AppConfig = typeof config;
