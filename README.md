# CharmShot Backend

AI image-generation platform backend. Users upload reference selfies and receive
enhanced photos that **preserve identity and resemblance** while improving
lighting, grooming, outfit, and composition.

Built with TypeScript on Node.js 22, deployed to AWS (API Gateway HTTP API +
Lambda + SQS + S3 + CloudWatch), backed by MongoDB, authenticated with Firebase,
and billed via RevenueCat. The image-generation model sits behind a provider
factory so new models can be added without touching job orchestration.

---

## Table of contents

- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [API reference](#api-reference)
- [Data model](#data-model)
- [Model provider abstraction](#model-provider-abstraction)
- [Credits, free tier & paywall](#credits-free-tier--paywall)
- [Security & compliance](#security--compliance)
- [Observability](#observability)
- [Local development](#local-development)
- [Configuration & secrets](#configuration--secrets)
- [Deployment](#deployment)
- [Testing](#testing)

---

## Architecture

```
                ┌────────────────────────────────────────────────────────┐
   Firebase ID  │                                                        │
   token  ─────▶│  API Gateway (HTTP API)                                │
                │        │                                               │
                │        ▼                                               │
                │   API Lambda  ── verify token (Firebase Admin)         │
                │      │  │  │     upsert user / entitlement (MongoDB)    │
                │      │  │  └────▶ presign S3 upload URL                 │
                │      │  └───────▶ reserve credits + create job (Mongo)  │
                │      │            enqueue ──────────────┐               │
                │      └───────────▶ read job status      │               │
                └──────────────────────────────────────── │ ──────────────┘
                                                           ▼
                                                   ┌──────────────┐  on repeated
                                                   │ SQS queue    │──failure──▶ DLQ
                                                   └──────┬───────┘
                                                          ▼
                                                  ┌────────────────┐
                                                  │ Worker Lambda  │
                                                  │  fetch refs(S3)│
                                                  │  provider strat│──▶ Model provider(s)
                                                  │  write results │      (Nano Banana, …)
                                                  │  update Mongo  │
                                                  └────────────────┘
```

**Generation is asynchronous.** The API Lambda only reserves credits, persists a
`PENDING` job, and enqueues an SQS message. The Worker Lambda does the heavy
lifting (fetch references, run the model via the provider strategy, write
results to S3, update the job). Status is polled via `GET /v1/generations/{jobId}`.

Key properties:

- **Provider-agnostic pipeline** — job logic never references a concrete model.
- **At-least-once safe** — the worker claims a job (`PENDING → PROCESSING`) once;
  duplicate SQS deliveries are no-ops.
- **Failure handling** — business failures mark the job `FAILED` and (optionally)
  refund credits; infrastructure failures bubble up as SQS batch-item failures
  and are retried, eventually landing in the DLQ.

---

## Repository layout

```
.
├── src/
│   ├── config/            # typed env configuration (non-secret)
│   ├── shared/            # logger, errors, metrics, retry, ids, types
│   ├── validation/        # zod request schemas
│   ├── aws/               # S3, SQS, Secrets Manager clients
│   ├── db/                # MongoDB connection + index management
│   ├── repositories/      # users, jobs, entitlements, webhook_events, audit
│   ├── auth/              # Firebase ID token verification
│   ├── providers/         # provider interface, factory/registry, strategy,
│   │                      #   NanoBananaProvider
│   ├── presets/           # style presets w/ identity-preservation prompts
│   ├── services/          # auth, upload, generation, entitlement, webhook
│   ├── middleware/        # per-uid rate limiting
│   ├── http/              # framework-agnostic request/response types
│   ├── api/               # router + Lambda entrypoint + route handlers
│   ├── worker/            # SQS worker processor + Lambda entrypoint
│   └── local/             # local dev HTTP server
├── infra/                 # AWS CDK (TypeScript) app
├── tests/                 # vitest unit tests
├── .env.example           # environment variable reference
└── README.md
```

Separation of concerns is strict: **routes → services → repositories →
(providers / aws / db)**. Handlers contain no business logic; repositories
contain no HTTP concerns; providers know nothing about jobs.

---

## API reference

All endpoints except the webhook require:

```
Authorization: Bearer <firebase-id-token>
```

Errors use a consistent shape:

```json
{ "error": { "code": "INSUFFICIENT_CREDITS", "message": "...", "details": { } } }
```

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/uploads/presign` | Get a presigned S3 PUT URL for a reference image |
| `POST` | `/v1/generations` | Create a generation job (reserves credits, enqueues work) |
| `GET`  | `/v1/generations/{jobId}` | Get job status + signed result URLs |
| `GET`  | `/v1/presets` | List style presets |
| `GET`  | `/v1/me/entitlements` | Current plan + remaining credits |
| `POST` | `/v1/webhooks/revenuecat` | RevenueCat webhook (secret-header auth) |
| `GET`  | `/health` | Health check (public) |

### `POST /v1/uploads/presign`

```jsonc
// request
{ "contentType": "image/jpeg", "fileName": "selfie.jpg" }
// response
{ "uploadUrl": "https://...signed...", "s3Key": "{uid}/uploads/{scope}/selfie.jpg" }
```

Allowed types: `image/jpeg`, `image/png`, `image/webp`. Max 10 MB. The client
`PUT`s the bytes directly to `uploadUrl` with a matching `Content-Type`.

### `POST /v1/generations`

```jsonc
// request
{
  "referenceImageKeys": ["{uid}/uploads/abc/selfie.jpg"],
  "presetId": "business-elite",
  "count": 4,
  "modelId": "nano-banana",        // optional; defaults to configured model
  "aspectRatio": "4:5",            // optional
  "seed": 12345                     // optional
}
// response (202-style)
{ "jobId": "job_...", "status": "PENDING" }
```

Reserves `count` credits atomically before enqueuing. Reference keys must live
under the caller's prefix.

### `GET /v1/generations/{jobId}`

```jsonc
{
  "jobId": "job_...",
  "status": "SUCCEEDED",
  "presetId": "business-elite",
  "count": 4,
  "modelUsed": "nano-banana",
  "results": [{ "index": 0, "url": "https://...signed-get..." }],
  "error": null,
  "createdAt": "2026-06-06T...",
  "updatedAt": "2026-06-06T..."
}
```

Result URLs are short-lived presigned GETs; S3 objects are never public.

---

## Data model

MongoDB holds all application state. Collections & key indexes:

| Collection | Unique / indexed | Notes |
|------------|------------------|-------|
| `users` | `uid` (unique) | `email`, `name`, `createdAt`, `updatedAt` |
| `jobs` | `jobId` (unique), `{uid, createdAt}` | status, providerUsed, resultKeys, error, creditsReserved |
| `entitlements` | `uid` (unique) | plan, creditsRemaining, entitlementActive, lastSyncedAt |
| `webhook_events` | `eventId` (unique) | type, uid, payloadHash, receivedAt (idempotency) |
| `audit_logs` | `{uid, createdAt}` | action, meta |
| `rate_limits` | TTL on `expiresAt` | fixed-window per-uid counters |

Indexes are ensured once per process on first DB access.

---

## Model provider abstraction

A provider implements a single interface:

```ts
interface ImageProvider {
  readonly id: string;
  readonly name: string;
  generateImages(params: {
    referenceImages: ReferenceImage[];
    prompt: string;
    count: number;
    stylePreset: string;
    aspectRatio: string;
    seed?: number;
  }): Promise<GeneratedImage[]>;
}
```

Providers are stored in a registry:

```ts
registerModelProvider('nano-banana', new NanoBananaProvider());
const provider = getModelProvider('nano-banana');
```

**Adding a new model is one line** in `src/providers/index.ts` — implement the
interface and register it. No changes to the worker, generation service, or API.

A **strategy** (`src/providers/strategy.ts`) layers selection on top:

- **primary** — the requested `modelId`, else the configured default
- **fallback** — tried automatically if the primary throws
- **weighted routing** — `pickWeighted([...])` for future A/B / cost routing

`Nano Banana` is implemented purely as `NanoBananaProvider` — it is never
referenced by name anywhere in the orchestration code.

> The Nano Banana HTTP request/response mapping in `nanoBananaProvider.ts` is a
> documented, self-contained assumption. If the real API contract differs, only
> that file changes.

---

## Credits, free tier & paywall

- New users get `FREE_TIER_CREDITS` (default 10) on first access.
- `POST /v1/generations` reserves `count` credits via an **atomic
  compare-and-decrement** (`creditsRemaining >= count`), so concurrent requests
  can't overspend.
- If the job fails and `REFUND_ON_FAILURE=true`, the worker refunds the reserved
  credits.
- `GET /v1/me/entitlements` returns plan + remaining credits.

RevenueCat drives plan changes. The webhook:

1. Verifies a shared-secret `Authorization` header (from Secrets Manager).
2. Records `eventId` once in `webhook_events` for **idempotency** — duplicate
   deliveries are acknowledged but not re-applied.
3. Maps `app_user_id → Firebase uid` and updates plan/credits by event type
   (`INITIAL_PURCHASE`/`RENEWAL` → activate + grant; `EXPIRATION`/`BILLING_ISSUE`
   → downgrade to free).

---

## Security & compliance

- **Auth** on every non-webhook endpoint (Firebase ID token).
- **Input validation** with zod on all payloads.
- **Per-uid rate limiting** (fixed window in MongoDB; configurable).
- **All secrets** in AWS Secrets Manager (Mongo URI, Firebase service account,
  RevenueCat auth, provider keys).
- **Private S3 buckets**, `BLOCK_ALL` public access, **TLS-enforced**,
  **encrypted at rest** (SSE-S3). Access only via short-lived signed URLs.
- **User-scoped prefixes** — uploads/results live under `{uid}/...`; the API
  rejects reference keys outside the caller's prefix.
- **Retention** — uploads expire after 30 days, results after 90 days (S3
  lifecycle rules); tune in `infra/lib/charmshot-stack.ts`.

---

## Observability

- **Structured JSON logs** with `requestId`, `uid`, `jobId` bound per request.
- **CloudWatch metrics** via Embedded Metric Format: `jobs_created`,
  `jobs_succeeded`, `jobs_failed`, `provider_latency_ms` (+ `credits_reserved`,
  `credits_refunded`, `rate_limited`).
- **Alarms** on `jobs_failed` and DLQ depth.
- **Retries + timeouts** on model calls (exponential backoff w/ jitter).
- **DLQ** for messages that fail processing repeatedly.

---

## Local development

Requirements: Node.js 22.x, a MongoDB you can reach (local or Atlas).

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
#   set MONGODB_URI (local mongo is fine), and for real auth set
#   FIREBASE_PROJECT_ID (+ optionally a service-account secret).

# 3. Typecheck & test
npm run typecheck
npm test

# 4. Run the local API (mirrors the API Gateway → router contract)
npm run dev:api      # http://localhost:3000
curl localhost:3000/health
```

Notes for local mode:

- Without AWS credentials, S3/SQS calls won't reach AWS — use the unit tests or
  point at LocalStack if you need full local AWS emulation.
- The RevenueCat webhook secret falls back to `REVENUECAT_WEBHOOK_AUTH`.
- Provider keys fall back to `NANO_BANANA_API_KEY`.

---

## Configuration & secrets

Non-secret config is via environment variables — see [`.env.example`](.env.example)
for the full annotated list. In production the Lambdas read these from their
environment (set by CDK) and pull **secrets** from Secrets Manager:

| Secret name (CDK) | Shape |
|-------------------|-------|
| `charmshot/mongodb` | `{ "uri": "mongodb+srv://..." }` |
| `charmshot/firebase-service-account` | Firebase service-account JSON |
| `charmshot/revenuecat` | `{ "authHeader": "<webhook auth value>" }` |
| `charmshot/providers` | `{ "nanoBananaApiKey": "..." }` |

The CDK stack creates these secrets empty; populate them after the first deploy:

```bash
aws secretsmanager put-secret-value --secret-id charmshot/mongodb \
  --secret-string '{"uri":"mongodb+srv://user:pass@cluster/charmshot"}'
```

---

## Deployment

Infrastructure is AWS CDK (TypeScript) in `infra/`.

```bash
cd infra
npm install                # (also covered by root `npm install` workspaces)
npx cdk bootstrap          # first time per account/region
npm run synth              # inspect the CloudFormation
npm run deploy             # deploy the stack
```

The stack provisions:

- HTTP API + routes wired to the API Lambda
- API Lambda and SQS Worker Lambda (`NodejsFunction`, esbuild-bundled, Node 22)
- SQS queue + DLQ (redrive after 3 receives)
- Two private, encrypted S3 buckets (uploads, results) with CORS + lifecycle
- Secrets Manager secrets (empty — populate post-deploy)
- Least-privilege IAM (API can presign + enqueue + read needed secrets; worker
  can read references, write results, consume the queue, read its secrets)
- CloudWatch alarms (`jobs_failed`, DLQ depth)

After deploy, set secret values (see above). The API endpoint is exported as
`CharmShotApiEndpoint`.

---

## Testing

```bash
npm test            # run once
npm run test:watch  # watch mode
```

Covered:

- **Firebase auth verification** — `tests/auth.test.ts` (bearer parsing, verify +
  upsert, failure propagation)
- **Presigned upload flow** — `tests/upload.test.ts` (user-scoped keys, file-name
  sanitisation, content-type/size validation)
- **Job creation & status transitions** — `tests/generation.test.ts`
- **Model factory selection & fallback** — `tests/factory.test.ts`
- **RevenueCat webhook idempotency** — `tests/webhook.test.ts`
- **Credit reservation / refund** — `tests/credits.test.ts` (atomic
  compare-and-decrement, concurrency, refunds)

Tests mock the AWS/DB/Firebase boundaries, so no live infrastructure is needed.
