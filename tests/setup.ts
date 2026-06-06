/**
 * Test environment defaults. Runs before any test module is imported, so the
 * frozen `config` object (src/config/env.ts) reads these values at import time.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.AWS_REGION = 'us-east-1';
process.env.METRICS_ENABLED = 'false';

process.env.MONGODB_URI = 'mongodb://localhost:27017';
process.env.MONGODB_DB_NAME = 'charmshot_test';

process.env.UPLOADS_BUCKET = 'charmshot-uploads-test';
process.env.RESULTS_BUCKET = 'charmshot-results-test';

process.env.DEFAULT_MODEL_ID = 'nano-banana';
process.env.NANO_BANANA_API_KEY = 'test-nano-key';

process.env.REVENUECAT_WEBHOOK_AUTH = 'test-webhook-secret';
process.env.FREE_TIER_CREDITS = '10';
process.env.REFUND_ON_FAILURE = 'true';
