/**
 * Centralised, typed access to environment configuration.
 *
 * Only NON-SECRET configuration lives here. Actual secrets (Mongo URI,
 * Firebase service account, provider API keys, RevenueCat auth) are resolved
 * lazily at runtime from AWS Secrets Manager (see src/aws/secrets.ts), falling
 * back to env vars for local development.
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

  mongo: {
    uriEnv: optStr('MONGODB_URI'),
    dbName: str('MONGODB_DB_NAME', 'charmshot'),
    secretArn: optStr('MONGODB_SECRET_ARN'),
  },

  s3: {
    uploadsBucket: str('UPLOADS_BUCKET', 'charmshot-uploads'),
    resultsBucket: str('RESULTS_BUCKET', 'charmshot-results'),
    uploadUrlTtlSeconds: int('UPLOAD_URL_TTL_SECONDS', 900),
    resultUrlTtlSeconds: int('RESULT_URL_TTL_SECONDS', 900),
    maxUploadBytes: int('MAX_UPLOAD_BYTES', 10 * 1024 * 1024),
  },

  sqs: {
    generationQueueUrl: optStr('GENERATION_QUEUE_URL'),
  },

  firebase: {
    projectId: optStr('FIREBASE_PROJECT_ID') ?? 'charmshot-dev',
    serviceAccountSecretArn: optStr('FIREBASE_SERVICE_ACCOUNT_SECRET_ARN'),
  },

  revenuecat: {
    secretArn: optStr('REVENUECAT_SECRET_ARN'),
    webhookAuthEnv: optStr('REVENUECAT_WEBHOOK_AUTH'),
  },

  providers: {
    secretsArn: optStr('PROVIDER_SECRETS_ARN'),
    nanoBananaApiKeyEnv: optStr('NANO_BANANA_API_KEY'),
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
