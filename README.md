# CharmShot Backend

AI image-generation platform backend. Users upload reference selfies and receive
enhanced photos that **preserve identity and resemblance** while improving
lighting, grooming, outfit, and composition.

Built with TypeScript on Node.js 22 as a single long-running **Fastify server**
with an **in-process background worker**. State lives in MongoDB; uploaded and
generated images live in **S3 (the only external AWS dependency)**. Auth is
Firebase; billing is Razorpay (shell integration for now, gated by
`PAYMENTS_ENABLED`). The image model sits behind a provider factory
so new models can be added without touching job orchestration.

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
- [Configuration](#configuration)
- [Deployment](#deployment)
- [Testing](#testing)

---

## Architecture

```
   Firebase ID token
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │  Fastify server (one process)                 │
  │                                               │
  │   HTTP routes ── verify token (Firebase)      │
  │      │  │  │     upsert user/entitlement (Mongo)
  │      │  │  └────▶ presign S3 upload URL ──────┼──▶ S3 (uploads)
  │      │  └───────▶ reserve credits + create    │
  │      │            job (Mongo) ── enqueue ──┐   │
  │      └───────────▶ read job status         │   │
  │                                            ▼   │
  │   In-process worker (concurrency-limited)      │
  │      fetch refs (S3) ─────────────────────────┼──▶ S3 (uploads)
  │      provider strategy ──▶ model providers     │
  │      write results ───────────────────────────┼──▶ S3 (results)
  │      update job (Mongo)                        │
  └──────────────────────────────────────────────┘
                    │
                    ▼
                MongoDB
```

**Generation is asynchronous, in one process.** An HTTP request reserves credits,
persists a `PENDING` job, and hands it to the in-process queue, returning
`{ jobId, status: "PENDING" }` immediately. The background worker (a
concurrency-limited queue running in the same Node process) does the slow work —
fetch references, run the model via the provider strategy, write results to S3,
update the job. Clients poll `GET /v1/generations/{jobId}`.

Key properties:

- **One deployable** — server + worker in a single container; no SQS, no Lambda,
  no API Gateway. The only AWS service used is S3.
- **Provider-agnostic pipeline** — job logic never references a concrete model.
- **Restart-safe** — the queue is in-memory, so on boot the server re-enqueues
  any jobs left `PENDING`/`PROCESSING` in MongoDB (`recoverUnfinishedJobs`).
  Claiming a job (`PENDING → PROCESSING`) is guarded so duplicates are no-ops.
- **Failure handling** — business failures mark the job `FAILED` and (optionally)
  refund credits; unexpected errors are caught so one bad job can't crash the
  worker loop.
- **Graceful shutdown** — on SIGINT/SIGTERM the server stops accepting
  connections, drains in-flight jobs, then closes Mongo.

> Scaling note: with an in-process worker, run a small number of instances and
> tune `WORKER_CONCURRENCY`. If you later need to scale the API and the workers
> independently, set `WORKER_ENABLED=false` on the API instances and run
> separate worker instances — the queue/processor split already supports it.

---

## Repository layout

```
.
├── src/
│   ├── config/            # typed env configuration
│   ├── shared/            # logger, errors, metrics, posthog, telemetry, retry, ids, types
│   ├── validation/        # zod request schemas
│   ├── aws/               # S3 client (presign + server-side get/put)
│   ├── db/                # MongoDB connection + index management
│   ├── repositories/      # users, jobs, entitlements, webhook_events, audit
│   ├── auth/              # Firebase ID token verification
│   ├── providers/         # provider interface, factory/registry, strategy,
│   │                      #   NanoBananaProvider, OpenAIProvider
│   ├── presets/           # style presets w/ identity-preservation prompts
│   ├── services/          # auth, upload, generation, entitlement, webhook
│   ├── middleware/        # per-uid rate limiting
│   ├── queue/             # in-process background job queue (replaces SQS)
│   ├── http/              # framework-agnostic request/response types
│   ├── api/               # router + route handlers
│   ├── worker/            # generation processor + worker bootstrap
│   └── server/            # Fastify app + entrypoint
├── tests/                 # vitest: tests/unit/** and tests/integration/**
├── Dockerfile             # multi-stage production image
├── docker-compose.yml     # production-like local stack (built image + mongo)
├── dev-docker.yaml        # dev dependencies only (mongo); run the server on the host
├── .env.example
└── README.md
```

Separation of concerns is strict: **routes → services → repositories →
(providers / aws / db)**. The Fastify layer is a thin adapter over the
framework-agnostic router (`src/api/router.ts`), so HTTP transport is swappable.

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
| `POST` | `/v1/webhooks/razorpay` | Razorpay webhook (signature-header auth; 503 when payments disabled) |
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
// response (201)
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

## API documentation (Swagger / OpenAPI)

Interactive docs are generated from the **same zod schemas** used for request
validation, so the published contract can't drift from the code.

- **Swagger UI:** `GET /docs` (try-it-out enabled)
- **Raw spec:** `GET /openapi.json` (OpenAPI 3.1)
- **Committed spec files:** [`docs/openapi.json`](docs/openapi.json) and
  [`docs/openapi.yaml`](docs/openapi.yaml) for client/codegen tooling

```bash
npm run openapi:export   # regenerate docs/openapi.{json,yaml}
npm run openapi:check    # CI fails if the committed spec is stale
```

The spec is built in `src/openapi/document.ts` (via `@asteasolutions/zod-to-openapi`)
and served by `@fastify/swagger` + `@fastify/swagger-ui`. To add/adjust an
endpoint's docs, update its zod schema and the matching `registerPath(...)` entry,
then run `npm run openapi:export`.

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

Providers are stored in a registry (`registerModelProvider` / `getModelProvider`).
**Adding a new model is one line** in `src/providers/index.ts`. A **strategy**
(`src/providers/strategy.ts`) layers selection on top: a **primary** provider
(requested `modelId` or the configured default), an automatic **fallback** if the
primary throws, and optional **weighted routing**. `Nano Banana` is implemented
purely as `NanoBananaProvider` and is never referenced by name in orchestration.

> **Nano Banana** is Google's nickname for its Gemini image models; we default to
> **Nano Banana 2 = Gemini 3.1 Flash Image** (`gemini-3.1-flash-image-preview`).
> `NanoBananaProvider` calls the real Gemini API
> (`POST {baseUrl}/models/{model}:generateContent`, `x-goog-api-key` auth) and is
> the only place those specifics live. The model returns one image per call, so a
> job with `count > 1` fans out that many parallel requests. Configure it with
> `NANO_BANANA_API_KEY` (a Gemini API key), `NANO_BANANA_BASE_URL`,
> `NANO_BANANA_MODEL`, and optionally `NANO_BANANA_IMAGE_SIZE`
> (`512`/`1K`/`2K`/`4K`, a Nano Banana 2 feature).

> **OpenAI** (`OpenAIProvider`, id `openai`) calls the real OpenAI Images API
> (`gpt-image-1`). When reference selfies are present it uses the **image edits**
> endpoint (`POST {baseUrl}/images/edits`, `multipart/form-data`, selfies sent as
> `image[]`) for identity preservation; with no references it falls back to
> text-to-image **generations** (`POST {baseUrl}/images/generations`). Unlike Nano
> Banana it returns all `n` images in one call. The aspect ratio is mapped to the
> model's supported sizes (square / landscape / portrait), and there is no `seed`.
> Configure it with `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_IMAGE_MODEL`, and
> optionally `OPENAI_IMAGE_QUALITY`, `OPENAI_IMAGE_OUTPUT_FORMAT`, and
> `OPENAI_IMAGE_SIZE`. **Which provider runs jobs is env-controlled** via
> `DEFAULT_MODEL_ID` (e.g. `openai`) / `FALLBACK_MODEL_ID`, or per request via the
> `modelId` field — moving to a user preference later.

---

## Credits, free tier & paywall

- New users get `FREE_TIER_CREDITS` (default 10) on first access.
- `POST /v1/generations` reserves `count` credits via an **atomic
  compare-and-decrement** (`creditsRemaining >= count`), safe under concurrency.
- If the job fails and `REFUND_ON_FAILURE=true`, the worker refunds the credits.
- `GET /v1/me/entitlements` returns plan + remaining credits.

Razorpay will drive plan changes via `POST /v1/webhooks/razorpay`. The
integration is currently a **shell** (`src/services/paymentService.ts`) and the
whole payments surface is gated by `PAYMENTS_ENABLED` (default `false` — the
webhook returns 503 while disabled). What's wired today:

1. Verifies the `X-Razorpay-Signature` header is present (real HMAC
   verification against `RAZORPAY_WEBHOOK_SECRET` is a TODO).
2. Records the event id (`X-Razorpay-Event-Id` header, else a body hash) once
   in `webhook_events` for **idempotency** — duplicate deliveries are
   acknowledged but not re-applied.
3. Event-to-entitlement mapping (plan/credit updates) is a TODO stub.

---

## Security & compliance

- **Auth** on every non-webhook endpoint (Firebase ID token).
- **Input validation** with zod on all payloads.
- **Per-uid rate limiting** (fixed window in MongoDB; configurable).
- **Config via environment variables** (12-factor); inject secrets through your
  orchestrator's secret store. No secrets are committed.
- **Private S3 buckets**, access only via short-lived signed URLs; encrypt at
  rest via bucket default encryption.
- **User-scoped prefixes** — uploads/results live under `{uid}/...`; the API
  rejects reference keys outside the caller's prefix.
- **Retention** — enforce upload/result lifecycle expiry with S3 lifecycle rules
  on the buckets (e.g. 30 days uploads, 90 days results).

---

## Observability

- **Structured JSON logs** with `requestId`, `uid`, `jobId` bound per request.
- **Metrics** emitted as structured `kind:"metric"` log lines (jobs_created,
  jobs_succeeded, jobs_failed, provider_latency_ms, credits_*). A log shipper can
  turn these into counters/timers; swap `src/shared/metrics.ts` for StatsD/OTEL
  if desired.
- **PostHog (optional, off by default)** — set `POSTHOG_ENABLED=true` +
  `POSTHOG_API_KEY` to ship analytics, AI observability, and logs to PostHog:
  - **Analytics**: every metric is also captured as a product-analytics event
    (`src/shared/posthog.ts`), attributed to the user (`uid`) where known.
    PostHog has no raw metric ingestion, so counters/timers are built as
    Insights/Trends over the event's `value`.
  - **AI observability**: the provider strategy emits a `$ai_generation` event
    per attempt — `$ai_model` is the concrete model (`gpt-image-1`,
    `gemini-3.1-flash-image-preview`), `$ai_provider` is the route id
    (`openai`/`nano-banana`), plus latency, trace id = `jobId`, and error. This
    is provider-agnostic, so every registered model (incl. fallbacks) is covered
    in PostHog's LLM Analytics with no per-provider wiring.
  - **Logs**: set `POSTHOG_LOGS_ENABLED=true` to ship structured logs to
    PostHog Logs over OTLP (`src/shared/telemetry.ts`); the stdout logger is
    unchanged. See `.env.example` for all `POSTHOG_*` settings.
- **Retries + timeouts** on model calls (exponential backoff w/ jitter).
- **Health check** at `GET /health` (used by the Docker `HEALTHCHECK`).

---

## Local development

Requirements: Node.js 22.x and a MongoDB you can reach.

The repo ships two Compose files for different goals:

| File | Goal | Source | MongoDB |
|------|------|--------|---------|
| `dev-docker.yaml` | **Development** — dependencies only (MongoDB); run the server on your host | host `npm run dev` (`tsx watch`) | bundled `mongo:7` |
| `docker-compose.yml` | **Production-like** — runs the built image in a container | multi-stage `Dockerfile` | bundled `mongo:7` |

### Option A — Dev dependencies in Docker, server on your host (`dev-docker.yaml`)

The recommended day-to-day setup. `dev-docker.yaml` runs **only the
dependencies** (currently just MongoDB) in Docker; you run the server itself on
your host with `npm run dev`, which gives you native hot reload and easy
debugging while talking to the containerized Mongo.

```bash
# 1. Start the dependencies (MongoDB on localhost:27017) in the background.
docker compose -f dev-docker.yaml up -d

# 2. Configure your local .env (see below), then run the server on your host.
npm install
npm run dev                   # tsx watch src/server/index.ts
curl localhost:8080/health    # {"status":"ok"}
```

Create your local `.env` from the example and point it at the Dockerized Mongo:

```bash
cp .env.example .env
```

The key value is the Mongo URL — because the server runs on your host (not in
the Compose network), use `localhost`, not the `mongo` service name:

```dotenv
MONGODB_URI=mongodb://localhost:27017
MONGODB_DB_NAME=charmshot_dev
```

S3 is a **real (dev) bucket**, so also set AWS credentials and bucket names in
`.env`. You can create the dev buckets with the Serverless template in this repo
(`npx serverless deploy --stage dev`), then set `UPLOADS_BUCKET` /
`RESULTS_BUCKET` to its outputs:

```dotenv
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
UPLOADS_BUCKET=charmshot-uploads-dev
RESULTS_BUCKET=charmshot-results-dev
```

Edit files under `./src` and the host server reloads automatically. Stop the
server with `Ctrl+C`; stop MongoDB with `docker compose -f dev-docker.yaml
down` (add `-v` to also remove the Mongo data volume). Auth/provider/billing
values default to dev placeholders (see `.env.example`) and can be overridden
in `.env`.

### Option B — Production-like Compose (`docker-compose.yml`)

Builds and runs the production image from the `Dockerfile` (no hot reload),
plus a bundled MongoDB — useful for verifying the container behaves as it will
in production.

```bash
cp .env.example .env          # fill in S3 creds/buckets, etc.
docker compose up --build
curl localhost:8080/health    # {"status":"ok"}
```

### Option C — run the server directly

```bash
npm install
cp .env.example .env          # set MONGODB_URI etc.
npm run build && node --env-file=.env dist/server/index.js
# or hot-reload during development:
npm run dev                   # tsx watch src/server/index.ts
```

Notes:

- S3 is required for uploads/results. Use real AWS creds, or run MinIO/LocalStack
  and set `S3_ENDPOINT` + `S3_FORCE_PATH_STYLE=true` (see `docker-compose.yml`).
- Without a Firebase service account, ID tokens are verified against Google's
  public JWKS using `FIREBASE_PROJECT_ID` alone.

---

## Configuration

All configuration is via environment variables — see [`.env.example`](.env.example)
for the full annotated list. Key groups: server (`PORT`, `HOST`), worker
(`WORKER_ENABLED`, `WORKER_CONCURRENCY`), Mongo (`MONGODB_URI`,
`MONGODB_DB_NAME`), S3 (`AWS_*`, `UPLOADS_BUCKET`, `RESULTS_BUCKET`,
`S3_ENDPOINT`), Firebase (`FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON`),
payments (`PAYMENTS_ENABLED`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`RAZORPAY_WEBHOOK_SECRET`), providers (`NANO_BANANA_API_KEY`,
`DEFAULT_MODEL_ID`, `FALLBACK_MODEL_ID`), and credits/rate-limit settings.

---

## Deployment

The service ships as a single container image (`Dockerfile`, multi-stage).

```bash
docker build -t charmshot-backend:latest .
docker run -p 8080:8080 --env-file .env charmshot-backend:latest
```

Run it anywhere that runs containers (ECS/Fargate, Kubernetes, Fly.io, a VM,
etc.). Provide configuration via environment variables / your platform's secret
manager. The container exposes port 8080 and has a built-in `/health` healthcheck.
Front it with your platform's load balancer / TLS terminator. Point it at a
managed MongoDB (e.g. Atlas) and an S3 bucket pair with private access + default
encryption + lifecycle retention rules.

---

## Versioning & releases

Versioning is automated from [Conventional Commits](https://www.conventionalcommits.org)
via [semantic-release](https://semantic-release.gitbook.io). When a PR is merged
into `main`, a release workflow:

1. Reads the merged commits and computes the next [SemVer](https://semver.org):
   `fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major.
2. Updates `package.json` + `CHANGELOG.md` and commits them back (`[skip ci]`).
3. Creates the git tag and a **GitHub Release** with generated notes.

Commits with non-releasable types (`docs`, `chore`, `refactor`, `test`, `ci`,
`build`, `style`) don't trigger a release.

Because PRs are **squash-merged**, the **PR title** is the commit that lands on
`main` — so it must be a valid Conventional Commit. The `PR Title` workflow
enforces this on every PR. Examples:

```
feat: add weighted provider routing
fix: refund credits when the worker times out
feat!: change /v1/generations response shape   # major bump
```

Triggering honors the "CI on PRs only" policy: the release runs off the
`pull_request` merged event (no `push` triggers). `package.json` carries
`0.0.0-development` on `main`; the real version lives in the git tags / GitHub
Releases.

A Husky **`commit-msg` hook** runs commitlint on every local commit so badly
formatted messages are rejected before they're created (config in
`commitlint.config.cjs`). The hook is installed automatically by the `prepare`
script on `npm install`; you can also check a message manually with
`npm run commitlint`.

## Testing

```bash
npm run test:unit          # unit tests (no external deps)
npm run test:integration   # integration tests (real MongoDB; auto-skip if none)
npm run test:coverage      # unit tests with coverage
npm run test:all           # unit then integration
```

- **Unit** (`tests/unit/**`) — no external dependencies; boundaries mocked. Covers
  shared utils, validation, presets, provider factory/strategy, NanoBanana
  provider, services, HTTP responses, router, and the Fastify adapter.
- **Integration** (`tests/integration/**`) — exercise router → services →
  repositories against a **real MongoDB** (`MONGODB_URI`, default
  `mongodb://localhost:27017`); only S3/Firebase boundaries are mocked. They
  auto-skip when no MongoDB is reachable and run for real in CI.

### CI

`.github/workflows/ci.yml` runs on pull requests only:

| Job | What |
|-----|------|
| Lint & Typecheck | `tsc --noEmit` + OpenAPI spec sync check |
| Unit Tests | `npm run test:coverage` + coverage artifact |
| Integration Tests | `npm run test:integration` against a `mongo:7` service container |
| Docker Build | builds the production image |
