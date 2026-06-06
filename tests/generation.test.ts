import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRecord } from '../src/shared/types';

// --- Mocks ----------------------------------------------------------------
const { reserveCredits, refundCredits, createJob, markFailed, findJobForUser, enqueueGenerationJob, audit } =
  vi.hoisted(() => ({
    reserveCredits: vi.fn(),
    refundCredits: vi.fn(async () => undefined),
    createJob: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    findJobForUser: vi.fn(),
    enqueueGenerationJob: vi.fn(async () => undefined),
    audit: vi.fn(async () => undefined),
  }));
vi.mock('../src/repositories/entitlementRepository', () => ({ reserveCredits, refundCredits }));
vi.mock('../src/repositories/jobRepository', () => ({ createJob, markFailed, findJobForUser }));
vi.mock('../src/aws/sqs', () => ({ enqueueGenerationJob }));
vi.mock('../src/repositories/auditLogRepository', () => ({ audit }));

vi.mock('../src/aws/s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/aws/s3')>();
  return { ...actual, presignResult: vi.fn(async (key: string) => `https://signed/${key}`) };
});

import { createGeneration, getGenerationStatus } from '../src/services/generationService';
import { rootLogger } from '../src/shared/logger';
import { AppError } from '../src/shared/errors';

const uid = 'uid-1';
const validInput = {
  referenceImageKeys: [`${uid}/uploads/abc/selfie.jpg`],
  presetId: 'casual-smart',
  count: 2,
  aspectRatio: '1:1' as const,
};

describe('createGeneration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reserveCredits.mockResolvedValue({ uid, creditsRemaining: 8 });
  });

  it('reserves credits, creates a PENDING job, and enqueues work', async () => {
    const res = await createGeneration(uid, validInput, rootLogger);
    expect(res.status).toBe('PENDING');
    expect(res.jobId).toMatch(/^job_/);
    expect(reserveCredits).toHaveBeenCalledWith(uid, 2);
    expect(createJob).toHaveBeenCalledTimes(1);
    expect(enqueueGenerationJob).toHaveBeenCalledWith({ jobId: res.jobId, uid });
  });

  it('rejects when credits are insufficient (no job created)', async () => {
    reserveCredits.mockResolvedValue(null);
    await expect(createGeneration(uid, validInput, rootLogger)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS',
    });
    expect(createJob).not.toHaveBeenCalled();
    expect(enqueueGenerationJob).not.toHaveBeenCalled();
  });

  it('rejects reference keys that do not belong to the user', async () => {
    await expect(
      createGeneration(uid, { ...validInput, referenceImageKeys: ['other-uid/x/y.jpg'] }, rootLogger),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  it('refunds credits and marks job failed if enqueue fails', async () => {
    enqueueGenerationJob.mockRejectedValueOnce(new Error('sqs down'));
    await expect(createGeneration(uid, validInput, rootLogger)).rejects.toThrowError(AppError);
    expect(refundCredits).toHaveBeenCalledWith(uid, 2);
    expect(markFailed).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: 'ENQUEUE_FAILED' }),
      { creditsRefunded: true },
    );
  });

  it('rejects an unknown preset', async () => {
    await expect(
      createGeneration(uid, { ...validInput, presetId: 'nope' }, rootLogger),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('getGenerationStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  const baseJob: JobRecord = {
    jobId: 'job_x',
    uid,
    presetId: 'casual-smart',
    modelId: 'nano-banana',
    count: 2,
    status: 'PENDING',
    referenceImageKeys: [`${uid}/u/a.jpg`],
    resultKeys: [],
    creditsReserved: 2,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('returns NOT_FOUND for a missing job', async () => {
    findJobForUser.mockResolvedValue(null);
    await expect(getGenerationStatus(uid, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('returns status with no results while pending', async () => {
    findJobForUser.mockResolvedValue(baseJob);
    const res = await getGenerationStatus(uid, 'job_x');
    expect(res.status).toBe('PENDING');
    expect(res.results).toEqual([]);
    expect(res.modelUsed).toBe('nano-banana');
  });

  it('returns signed URLs and providerUsed once succeeded', async () => {
    findJobForUser.mockResolvedValue({
      ...baseJob,
      status: 'SUCCEEDED',
      providerUsed: 'nano-banana',
      resultKeys: [`${uid}/job_x/0.webp`, `${uid}/job_x/1.webp`],
    });
    const res = await getGenerationStatus(uid, 'job_x');
    expect(res.status).toBe('SUCCEEDED');
    expect(res.results).toHaveLength(2);
    expect(res.results[0]?.url).toContain('https://signed/');
    expect(res.modelUsed).toBe('nano-banana');
  });
});
