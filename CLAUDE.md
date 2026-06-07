# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CharmShot backend: an AI image-generation API. Clients upload reference selfies
and request identity-preserving enhanced photos. TypeScript on Node.js 22,
running as a **single long-lived process**: a Fastify HTTP server plus an
**in-process background worker** in the same process. State is in MongoDB;
images live in **S3 (the only external AWS dependency)**. Auth is Firebase;
billing is RevenueCat.

## Commands

```bash
npm run dev                 # hot-reload dev server (tsx watch src/server/index.ts)
npm run build               # tsc → dist/
npm start                   # run built server (node dist/server/index.js)
npm run typecheck           # tsc --noEmit  (this is also what `npm run lint` runs)

npm run test:unit           # unit tests, no external deps
npm run test:integration    # integration tests; needs a real MongoDB (auto-skips if none)
npm run test:coverage       # unit tests + coverage
npm run test:all            # unit then integration
npx vitest run path/to/x.test.ts          # single unit file
npx vitest run -t "name of test"          # single test by name
npx vitest run --config vitest.integration.config.ts path/to/x.test.ts  # single integration file

npm run openapi:export      # regenerate docs/openapi.{json,yaml} from zod schemas
npm run openapi:check       # CI check that the committed spec is not stale
```

There is **no ESLint** — `lint` is just `tsc --noEmit`. Local Docker stacks:
`docker compose -f dev-docker.yaml up --build` (hot reload) or
`docker compose up --build` (production-like built image); both bundle MongoDB.

## Architecture

**Request flow is layered and strict:** `routes → services → repositories → (providers / aws / db)`. Don't shortcut across layers (e.g. a route reaching into a repository directly).

**The HTTP layer is a thin adapter.** `src/server/app.ts` (Fastify) does transport only — it normalizes the request into a framework-agnostic `HttpRequest` and calls `dispatch()` in `src/api/router.ts`. The router owns auth, rate limiting, routing, and the error envelope. This split is deliberate (Fastify is swappable; a Lambda adapter previously used the same router), so keep handler/service logic out of `app.ts`.

- Adding a route means editing **two** places: the `ROUTES` table in `app.ts` (Fastify uses `:param`) **and** the `authedRoutes`/`publicRoutes` maps in `router.ts` (internal router uses `{param}`).
- Authenticated routes are wrapped by the router with Firebase token verification + per-uid rate limiting before the handler runs. The RevenueCat webhook is a **public** route that does its own secret-header auth, and needs the **raw** request body (preserved via a custom content-type parser in `app.ts`) to verify/hash.

**Generation is asynchronous in one process.** `POST /v1/generations` reserves credits, persists a `PENDING` job, enqueues it, and returns `{ jobId, status: "PENDING" }` immediately. The in-process queue (`src/queue/jobQueue.ts`, an in-memory concurrency-limited singleton) drives the job to a terminal state via the processor (`src/worker/processor.ts`). Clients poll `GET /v1/generations/{jobId}`.

- The queue is **in-memory**, so it's decoupled from job logic: the worker registers the processor at boot via `setProcessor`. Because a restart loses queued work, `recoverUnfinishedJobs` re-enqueues any `PENDING`/`PROCESSING` jobs from MongoDB on startup (`src/server/index.ts`). Claiming a job (`markProcessing`, `PENDING → PROCESSING`) is guarded so re-deliveries are safe no-ops.
- Set `WORKER_ENABLED=false` to run an API-only instance (no worker). The queue/processor split supports scaling API and workers separately.
- The processor comments still reference "SQS"/"DLQ" — that's legacy wording; there is no SQS, only the in-process queue.

**Provider abstraction** (`src/providers/`) keeps job logic free of any concrete model name. Providers implement the `ImageProvider` interface (`types.ts`) and are kept in a registry (`factory.ts`). **Register new providers with one line in `index.ts`'s `bootstrapProviders()`** — nothing else changes. Selection lives in `strategy.ts`: `executeWithStrategy` resolves a primary (requested `modelId` or configured default) → fallback chain and reports which provider actually produced output; `pickWeighted` supports optional weighted routing. `nano-banana` (NanoBananaProvider) is the only built-in; its HTTP request/response mapping is a documented self-contained assumption — if the real API differs, only `nanoBananaProvider.ts` changes.

**Credits & failure semantics.** Credits are reserved with an atomic compare-and-decrement before enqueue. In the processor, a **business failure** (provider chain exhausted, missing preset) marks the job `FAILED`, refunds credits if `REFUND_ON_FAILURE=true`, and returns normally. Only **infrastructure failures** propagate. The queue wrapper additionally catches unexpected throws so one bad job never crashes the worker loop.

**Config** is centralized and typed in `src/config/env.ts` (12-factor; see `.env.example`). Read config through it rather than touching `process.env` directly.

**OpenAPI is generated from the same zod schemas used for request validation** (`src/validation/schemas.ts` → `src/openapi/document.ts`), so the published contract can't drift from validation. After changing an endpoint's schema or its `registerPath(...)` entry, run `npm run openapi:export`; CI runs `openapi:check` and fails if the committed spec is stale.

**Observability:** structured JSON logs via `src/shared/logger.ts` with `requestId`/`uid`/`jobId` bound per request (use `logger.child({...})`); metrics are emitted as `kind:"metric"` log lines through `src/shared/metrics.ts`. **PostHog** is an optional, off-by-default sink (gated by `POSTHOG_ENABLED` + `POSTHOG_API_KEY`): `src/shared/metrics.ts` also forwards each metric to PostHog as a product-analytics event; the provider strategy (`src/providers/strategy.ts`) emits `$ai_generation` events for LLM Analytics (provider-agnostic — `$ai_model` is the provider's concrete `model`, `$ai_provider` its `id`, so every registered provider incl. fallbacks is covered); and with `POSTHOG_LOGS_ENABLED` the logger ships logs to PostHog Logs over OTLP (`src/shared/telemetry.ts`). The PostHog client (`src/shared/posthog.ts`) is a lazy singleton and a no-op when disabled — call sites never branch on config. Flush on shutdown is wired in `src/server/index.ts`.

**Tracing** is OpenTelemetry spans exported over OTLP/HTTP (`src/shared/tracing.ts`), off by default and gated by `TRACING_ENABLED`; it's backend-agnostic (any OTLP collector — Jaeger/Tempo/Honeycomb/Datadog/OTel Collector — via the standard `OTEL_EXPORTER_OTLP_*` env vars). Like the PostHog integration, **call sites never branch on config**: the OTel API hands back a no-op tracer when nothing is registered, so `withSpan(name, fn, opts)` always just runs `fn` (and adds nothing to logs) when disabled. Span coverage: the router opens a **SERVER** span per request (continuing any inbound W3C `traceparent`, tagging route/status/uid); the job queue (`src/queue/jobQueue.ts`) opens a **CONSUMER** span per job, **linked** to the request that enqueued it (trace context is captured at enqueue in `generationService` and rides on the queue message — recovered jobs simply have no link); the provider strategy opens a **CLIENT** span per attempt with `gen_ai.*` attributes (so fallbacks show as sibling spans); and the processor adds phase spans (`references.fetch`, `results.persist`) plus business attributes/outcome. Every log line is stamped with the active `trace_id`/`span_id` (`logger.ts` ↔ `tracing.ts`) so logs join their trace. `startTracing`/`shutdownTracing` are wired in `src/server/index.ts`. To instrument new work, wrap it in `withSpan(...)`; don't construct spans by hand.

## Conventions that bite

- **Commits and PR titles must be Conventional Commits** — a Husky `commit-msg` hook runs commitlint locally, and squash-merge means the **PR title** becomes the release commit. `feat:` → minor, `fix:` → patch, `feat!:`/`BREAKING CHANGE:` → major; `docs`/`chore`/`refactor`/`test`/`ci`/`build`/`style` don't release. Releases are automated via semantic-release on merge to `main`.
- **CI runs on pull requests only** (no `push` triggers): typecheck + OpenAPI sync, unit tests w/ coverage, integration tests against a `mongo:7` service container, and a Docker build.
- Integration tests run **single-threaded** against a shared real MongoDB and gate themselves off (skip) when none is reachable via `MONGODB_URI`.
- S3 objects are never public; all access is via short-lived presigned URLs, and uploads/results are scoped under `{uid}/...` — the API rejects reference keys outside the caller's prefix.
