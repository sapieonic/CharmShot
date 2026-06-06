/**
 * OpenAI provider end-to-end flow (integration).
 *
 * Unlike generationFlow.test.ts — which registers a deterministic *fake*
 * provider — this suite registers the REAL OpenAIProvider and stubs only the
 * outbound `fetch`. It therefore exercises the full stack with OpenAI as the
 * selected model: router → service → worker → OpenAIProvider → (fake) S3, with
 * a REAL MongoDB. This proves env-driven model selection (modelId: "openai")
 * and the provider's edits-endpoint wiring work through the worker.
 *
 * Mocked boundaries match the sibling flow test: Firebase auth, AWS S3, and the
 * in-process queue. MongoDB is NOT mocked.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID } from '../../helpers/fakes';
import { authedRequest, parseBody } from './requestBuilder';

const { s3State } = vi.hoisted(() => ({
  s3State: { uploads: new Map<string, Buffer>(), results: new Map<string, Buffer>() },
}));

vi.mock('../../../src/auth/firebase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/auth/firebase')>();
  const { fakeVerifier } = await import('../../helpers/fakes');
  const verifier = fakeVerifier();
  return {
    ...actual,
    extractBearerToken: actual.extractBearerToken,
    verifyIdToken: verifier.verifyIdToken,
    defaultVerifier: verifier,
  };
});

vi.mock('../../../src/aws/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/aws/s3')>();
  return {
    ...actual,
    presignUpload: vi.fn(async (params: { key: string; contentType: string }) => ({
      uploadUrl: `https://uploads.test/${params.key}?sig=fake`,
      s3Key: params.key,
    })),
    presignResult: vi.fn(async (key: string) => `https://results.test/${key}?sig=fake`),
    getUploadBytes: vi.fn(async (key: string) => s3State.uploads.get(key) ?? Buffer.from(`upload:${key}`)),
    putResult: vi.fn(async (params: { key: string; body: Buffer }) => {
      s3State.results.set(params.key, params.body);
    }),
  };
});

vi.mock('../../../src/queue/jobQueue', () => ({
  enqueueGenerationJob: vi.fn(async () => undefined),
}));

import { dispatch } from '../../../src/api/router';
import { collections } from '../../../src/db/mongo';
import { config } from '../../../src/config/env';
import { registerModelProvider, _resetRegistry } from '../../../src/providers/factory';
import { OpenAIProvider } from '../../../src/providers/openAiProvider';
import { processGenerationJob } from '../../../src/worker/processor';
import { rootLogger } from '../../../src/shared/logger';

const OPENAI_BASE = 'https://api.openai.test/v1';

/** OpenAI Images API response carrying `count` base64 images. */
function openAiOk(count: number): Response {
  const body = { data: Array.from({ length: count }, (_, i) => ({ b64_json: Buffer.from(`img-${i}`).toString('base64') })) };
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function openAiError(status: number): Response {
  const body = { error: { message: 'bad request' } };
  return { ok: false, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe.skipIf(!mongoAvailable)('OpenAI generation flow (integration)', () => {
  beforeAll(() => {
    _resetRegistry();
    // Real provider; key/baseUrl injected so the suite never depends on env.
    registerModelProvider('openai', new OpenAIProvider({ apiKey: 'test-key', baseUrl: OPENAI_BASE, model: 'gpt-image-1' }));
  });

  beforeEach(async () => {
    await clearCollections();
    s3State.uploads.clear();
    s3State.results.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    _resetRegistry();
    await closeTestDb();
  });

  it('routes a job to OpenAI (edits endpoint) and succeeds end-to-end', async () => {
    const refKey = `${TEST_UID}/uploads/abc/selfie.jpg`;
    s3State.uploads.set(refKey, Buffer.from('selfie-bytes'));

    const fetchMock = vi.fn(async () => openAiOk(2));
    vi.stubGlobal('fetch', fetchMock);

    const createRes = await dispatch(
      authedRequest({
        method: 'POST',
        routePath: '/v1/generations',
        body: { referenceImageKeys: [refKey], presetId: 'casual-smart', count: 2, modelId: 'openai' },
      }),
    );
    expect(createRes.statusCode).toBe(201);
    const { jobId } = parseBody<{ jobId: string }>(createRes.body);

    await processGenerationJob(jobId, rootLogger);

    // OpenAI was actually called: edits endpoint, bearer token, n=2 in one call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_BASE}/images/edits`);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer test-key');
    expect((init.body as FormData).get('n')).toBe('2');

    const { jobs } = await collections();
    const succeeded = await jobs.findOne({ jobId });
    expect(succeeded?.status).toBe('SUCCEEDED');
    expect(succeeded?.providerUsed).toBe('openai');
    expect(succeeded?.resultKeys).toHaveLength(2);
    expect(s3State.results.size).toBe(2);

    const statusRes = await dispatch(
      authedRequest({ method: 'GET', routePath: '/v1/generations/{jobId}', pathParameters: { jobId } }),
    );
    const statusBody = parseBody<{ status: string; modelUsed: string }>(statusRes.body);
    expect(statusBody.status).toBe('SUCCEEDED');
    expect(statusBody.modelUsed).toBe('openai');
  });

  it('marks the job FAILED and refunds credits when OpenAI returns a 4xx', async () => {
    const refKey = `${TEST_UID}/uploads/xyz/selfie.jpg`;
    s3State.uploads.set(refKey, Buffer.from('selfie-bytes'));
    vi.stubGlobal('fetch', vi.fn(async () => openAiError(400)));

    const createRes = await dispatch(
      authedRequest({
        method: 'POST',
        routePath: '/v1/generations',
        body: { referenceImageKeys: [refKey], presetId: 'casual-smart', count: 3, modelId: 'openai' },
      }),
    );
    const { jobId } = parseBody<{ jobId: string }>(createRes.body);

    const { entitlements, jobs } = await collections();
    expect((await entitlements.findOne({ uid: TEST_UID }))?.creditsRemaining).toBe(config.credits.freeTierCredits - 3);

    await processGenerationJob(jobId, rootLogger);

    const failed = await jobs.findOne({ jobId });
    expect(failed?.status).toBe('FAILED');
    expect(failed?.creditsRefunded).toBe(true);
    // Balance restored after refund.
    expect((await entitlements.findOne({ uid: TEST_UID }))?.creditsRemaining).toBe(config.credits.freeTierCredits);
  });
});
