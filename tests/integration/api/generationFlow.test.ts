/**
 * End-to-end flow integration tests.
 *
 * These drive the REAL router (src/api/router.ts) against a REAL MongoDB,
 * mocking ONLY the external boundaries:
 *   - Firebase auth verification (auth/firebase) -> fakeVerifier()
 *   - AWS S3 (presign + server-side bytes) -> in-memory fakes (real key helpers)
 *   - AWS SQS (enqueue) -> no-op spy
 *   - The image provider -> a deterministic fake registered in the factory
 *
 * MongoDB is NOT mocked; user/entitlement/job/webhook state is verified by
 * reading collections() directly.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID } from '../../helpers/fakes';
import { authedRequest, buildRequest, parseBody } from './requestBuilder';

// --- Mock external boundaries (hoisted) -----------------------------------

// In-memory S3 state, shared between the s3 mock factory and the tests. Declared
// via vi.hoisted so it exists before the hoisted vi.mock factory runs.
const { s3State } = vi.hoisted(() => ({
  s3State: { uploads: new Map<string, Buffer>(), results: new Map<string, Buffer>() },
}));

vi.mock('../../../src/auth/firebase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth/firebase')>();
  const { fakeVerifier } = await import('../../helpers/fakes');
  const verifier = fakeVerifier();
  return {
    ...actual,
    // Keep the REAL extractBearerToken (router uses it directly).
    extractBearerToken: actual.extractBearerToken,
    // Any non-empty bearer token authenticates as TEST_UID via the fake.
    verifyIdToken: verifier.verifyIdToken,
    defaultVerifier: verifier,
  };
});

vi.mock('../../../src/aws/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/aws/s3')>();
  return {
    ...actual,
    // Keep REAL key/ownership helpers (uploadKey, resultKey, keyBelongsToUser).
    presignUpload: vi.fn(async (params: { key: string; contentType: string }) => ({
      uploadUrl: `https://uploads.test/${params.key}?sig=fake`,
      s3Key: params.key,
    })),
    presignResult: vi.fn(async (key: string) => `https://results.test/${key}?sig=fake`),
    getUploadBytes: vi.fn(async (key: string) => {
      const existing = s3State.uploads.get(key);
      // Default to a small deterministic buffer if nothing was "uploaded".
      return existing ?? Buffer.from(`upload:${key}`);
    }),
    putResult: vi.fn(async (params: { key: string; body: Buffer }) => {
      s3State.results.set(params.key, params.body);
    }),
  };
});

vi.mock('../../../src/queue/jobQueue', () => ({
  enqueueGenerationJob: vi.fn(async () => undefined),
}));

// --- Real modules (imported AFTER mocks are declared) ---------------------

import { dispatch } from '../../../src/api/router';
import { collections } from '../../../src/db/mongo';
import { config } from '../../../src/config/env';
import { registerModelProvider, _resetRegistry } from '../../../src/providers/factory';
import type { ImageProvider } from '../../../src/providers/types';
import { processGenerationJob } from '../../../src/worker/processor';
import { rootLogger } from '../../../src/shared/logger';
import { reserveCredits } from '../../../src/repositories/entitlementRepository';
import { enqueueGenerationJob } from '../../../src/queue/jobQueue';
import { presignResult } from '../../../src/aws/s3';

// A deterministic fake provider; `shouldFail` toggles the failure path.
const providerState = { shouldFail: false };

function makeFakeProvider(): ImageProvider {
  return {
    id: 'nano-banana',
    name: 'Fake Nano Banana',
    async generateImages(params) {
      if (providerState.shouldFail) {
        throw new Error('fake provider boom');
      }
      return Array.from({ length: params.count }, (_, i) => ({
        data: Buffer.from(`image-${i}`),
        contentType: 'image/webp',
        extension: 'webp',
      }));
    },
  };
}

const enqueueMock = vi.mocked(enqueueGenerationJob);
const presignResultMock = vi.mocked(presignResult);

describe.skipIf(!mongoAvailable)('generation flow (integration)', () => {
  beforeAll(() => {
    _resetRegistry();
    registerModelProvider('nano-banana', makeFakeProvider());
  });

  beforeEach(async () => {
    await clearCollections();
    s3State.uploads.clear();
    s3State.results.clear();
    providerState.shouldFail = false;
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it('POST /v1/uploads/presign returns a user-scoped key and provisions user + entitlement', async () => {
    const res = await dispatch(
      authedRequest({
        method: 'POST',
        routePath: '/v1/uploads/presign',
        body: { contentType: 'image/jpeg', fileName: 'selfie.jpg' },
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = parseBody<{ uploadUrl: string; s3Key: string }>(res.body);
    expect(body.s3Key.startsWith(`${TEST_UID}/`)).toBe(true);
    expect(body.s3Key.endsWith('selfie.jpg')).toBe(true);
    expect(body.uploadUrl).toContain(body.s3Key);

    // Auth side-effects: user + entitlement created in Mongo.
    const { users, entitlements } = await collections();
    expect(await users.countDocuments({ uid: TEST_UID })).toBe(1);
    const ent = await entitlements.findOne({ uid: TEST_UID });
    expect(ent?.creditsRemaining).toBe(config.credits.freeTierCredits);
    expect(ent?.plan).toBe('free');
  });

  it('GET /v1/presets returns the preset list', async () => {
    const res = await dispatch(authedRequest({ method: 'GET', routePath: '/v1/presets' }));
    expect(res.statusCode).toBe(200);
    const body = parseBody<{ presets: { id: string }[] }>(res.body);
    expect(body.presets.length).toBeGreaterThan(0);
    expect(body.presets.some((p) => p.id === 'casual-smart')).toBe(true);
  });

  it('GET /v1/me/entitlements returns free-tier credits', async () => {
    const res = await dispatch(authedRequest({ method: 'GET', routePath: '/v1/me/entitlements' }));
    expect(res.statusCode).toBe(200);
    const body = parseBody<{ plan: string; creditsRemaining: number; entitlementActive: boolean }>(res.body);
    expect(body.plan).toBe('free');
    expect(body.creditsRemaining).toBe(config.credits.freeTierCredits);
    expect(body.entitlementActive).toBe(true);
  });

  it('rejects unauthenticated requests (missing Authorization header)', async () => {
    const res = await dispatch(buildRequest({ method: 'GET', routePath: '/v1/me/entitlements' }));
    expect(res.statusCode).toBe(401);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('UNAUTHORIZED');
  });

  it('returns 404 for an unknown route', async () => {
    const res = await dispatch(authedRequest({ method: 'GET', routePath: '/v1/nope' }));
    expect(res.statusCode).toBe(404);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('NOT_FOUND');
  });

  it('full lifecycle: create -> worker succeeds -> status SUCCEEDED with signed URLs', async () => {
    const refKey = `${TEST_UID}/uploads/abc/selfie.jpg`;
    s3State.uploads.set(refKey, Buffer.from('selfie-bytes'));

    // Create the generation. Handler returns 201 (created).
    const createRes = await dispatch(
      authedRequest({
        method: 'POST',
        routePath: '/v1/generations',
        body: { referenceImageKeys: [refKey], presetId: 'casual-smart', count: 2 },
      }),
    );
    expect(createRes.statusCode).toBe(201);
    const { jobId, status } = parseBody<{ jobId: string; status: string }>(createRes.body);
    expect(status).toBe('PENDING');
    expect(jobId).toMatch(/^job_/);

    // Credits reserved in Mongo; job row created; SQS enqueue called.
    const { entitlements, jobs } = await collections();
    const afterReserve = await entitlements.findOne({ uid: TEST_UID });
    expect(afterReserve?.creditsRemaining).toBe(config.credits.freeTierCredits - 2);

    const jobDoc = await jobs.findOne({ jobId });
    expect(jobDoc?.status).toBe('PENDING');
    expect(jobDoc?.creditsReserved).toBe(2);
    expect(enqueueMock).toHaveBeenCalledWith({ jobId, uid: TEST_UID });

    // Run the worker against the fake provider + mocked S3.
    await processGenerationJob(jobId, rootLogger);

    // Job in Mongo now SUCCEEDED with resultKeys + providerUsed.
    const succeeded = await jobs.findOne({ jobId });
    expect(succeeded?.status).toBe('SUCCEEDED');
    expect(succeeded?.providerUsed).toBe('nano-banana');
    expect(succeeded?.resultKeys).toHaveLength(2);
    expect(succeeded?.resultKeys[0]).toBe(`${TEST_UID}/${jobId}/0.webp`);

    // Results were written to (fake) S3.
    expect(s3State.results.size).toBe(2);

    // GET status returns SUCCEEDED with signed result URLs.
    const statusRes = await dispatch(
      authedRequest({
        method: 'GET',
        routePath: '/v1/generations/{jobId}',
        pathParameters: { jobId },
      }),
    );
    expect(statusRes.statusCode).toBe(200);
    const statusBody = parseBody<{
      status: string;
      modelUsed: string;
      results: { index: number; url: string }[];
    }>(statusRes.body);
    expect(statusBody.status).toBe('SUCCEEDED');
    expect(statusBody.modelUsed).toBe('nano-banana');
    expect(statusBody.results).toHaveLength(2);
    expect(statusBody.results[0]?.url).toContain('https://results.test/');
    expect(presignResultMock).toHaveBeenCalled();

    // Credits decremented and NOT refunded on success.
    const finalEnt = await entitlements.findOne({ uid: TEST_UID });
    expect(finalEnt?.creditsRemaining).toBe(config.credits.freeTierCredits - 2);
    expect(succeeded?.creditsRefunded).toBeUndefined();
  });

  it('failure path: worker marks job FAILED and refunds credits (REFUND_ON_FAILURE=true)', async () => {
    const refKey = `${TEST_UID}/uploads/xyz/selfie.jpg`;

    const createRes = await dispatch(
      authedRequest({
        method: 'POST',
        routePath: '/v1/generations',
        body: { referenceImageKeys: [refKey], presetId: 'casual-smart', count: 3 },
      }),
    );
    expect(createRes.statusCode).toBe(201);
    const { jobId } = parseBody<{ jobId: string }>(createRes.body);

    const { entitlements, jobs } = await collections();
    expect((await entitlements.findOne({ uid: TEST_UID }))?.creditsRemaining).toBe(
      config.credits.freeTierCredits - 3,
    );

    // Make the provider throw, then run the worker.
    providerState.shouldFail = true;
    await processGenerationJob(jobId, rootLogger);

    const failed = await jobs.findOne({ jobId });
    expect(failed?.status).toBe('FAILED');
    expect(failed?.creditsRefunded).toBe(true);
    expect(failed?.error?.code).toBeDefined();

    // Balance restored.
    const restored = await entitlements.findOne({ uid: TEST_UID });
    expect(restored?.creditsRemaining).toBe(config.credits.freeTierCredits);

    // GET status reflects FAILED with no results.
    const statusRes = await dispatch(
      authedRequest({ method: 'GET', routePath: '/v1/generations/{jobId}', pathParameters: { jobId } }),
    );
    const statusBody = parseBody<{ status: string; results: unknown[]; error?: { code: string } }>(
      statusRes.body,
    );
    expect(statusBody.status).toBe('FAILED');
    expect(statusBody.results).toEqual([]);
    expect(statusBody.error?.code).toBeDefined();
  });

  it('insufficient credits: draining the balance yields 402 and creates no job', async () => {
    // Provision the user/entitlement first (an auth round-trip via presets).
    await dispatch(authedRequest({ method: 'GET', routePath: '/v1/presets' }));

    // Drain all credits directly via the repository.
    const drained = await reserveCredits(TEST_UID, config.credits.freeTierCredits);
    expect(drained?.creditsRemaining).toBe(0);

    const res = await dispatch(
      authedRequest({
        method: 'POST',
        routePath: '/v1/generations',
        body: { referenceImageKeys: [`${TEST_UID}/uploads/q/s.jpg`], presetId: 'casual-smart', count: 2 },
      }),
    );

    expect(res.statusCode).toBe(402);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('INSUFFICIENT_CREDITS');

    const { jobs } = await collections();
    expect(await jobs.countDocuments({ uid: TEST_UID })).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects reference keys that do not belong to the authenticated user (403)', async () => {
    const res = await dispatch(
      authedRequest({
        method: 'POST',
        routePath: '/v1/generations',
        body: { referenceImageKeys: ['someone-else/uploads/a.jpg'], presetId: 'casual-smart', count: 1 },
      }),
    );
    expect(res.statusCode).toBe(403);
    expect(parseBody<{ error: { code: string } }>(res.body).error.code).toBe('FORBIDDEN');

    // No credits should have been reserved (free tier intact).
    const { entitlements } = await collections();
    expect((await entitlements.findOne({ uid: TEST_UID }))?.creditsRemaining).toBe(
      config.credits.freeTierCredits,
    );
  });
});
