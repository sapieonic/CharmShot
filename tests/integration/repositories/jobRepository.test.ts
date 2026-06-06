/**
 * Integration tests for jobRepository against a REAL MongoDB.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { clearCollections, closeTestDb, mongoAvailable } from '../../helpers/db';
import { TEST_UID } from '../../helpers/fakes';
import {
  createJob,
  findJob,
  findJobForUser,
  listJobsForUser,
  markFailed,
  markProcessing,
  markSucceeded,
} from '../../../src/repositories/jobRepository';

const baseInput = {
  jobId: 'job_int_1',
  uid: TEST_UID,
  presetId: 'casual-smart',
  modelId: 'nano-banana',
  count: 2,
  referenceImageKeys: [`${TEST_UID}/uploads/abc/selfie.jpg`],
  creditsReserved: 2,
};

describe.skipIf(!mongoAvailable)('jobRepository (integration)', () => {
  beforeEach(async () => {
    await clearCollections();
  });
  afterAll(async () => {
    await closeTestDb();
  });

  it('createJob then findJob / findJobForUser, scoped to the owner', async () => {
    const job = await createJob(baseInput);
    expect(job.status).toBe('PENDING');
    expect(job.resultKeys).toEqual([]);

    const byId = await findJob('job_int_1');
    expect(byId?.jobId).toBe('job_int_1');

    const forOwner = await findJobForUser('job_int_1', TEST_UID);
    expect(forOwner?.jobId).toBe('job_int_1');

    // Another user cannot read it.
    const forOther = await findJobForUser('job_int_1', 'someone-else');
    expect(forOther).toBeNull();
  });

  it('persists optional aspectRatio + seed only when provided', async () => {
    await createJob({ ...baseInput, jobId: 'job_opt', aspectRatio: '4:5', seed: 42 });
    const withOpts = await findJob('job_opt');
    expect(withOpts?.aspectRatio).toBe('4:5');
    expect(withOpts?.seed).toBe(42);

    await createJob({ ...baseInput, jobId: 'job_noopt' });
    const noOpts = await findJob('job_noopt');
    expect(noOpts?.aspectRatio).toBeUndefined();
    expect(noOpts?.seed).toBeUndefined();
  });

  describe('markProcessing', () => {
    it('transitions PENDING -> PROCESSING', async () => {
      await createJob(baseInput);
      const res = await markProcessing('job_int_1');
      expect(res?.status).toBe('PROCESSING');
    });

    it('still claims a job already PROCESSING (filter allows PENDING or PROCESSING)', async () => {
      await createJob(baseInput);
      await markProcessing('job_int_1');
      // Second call: the implementation guards on status in {PENDING, PROCESSING},
      // so a PROCESSING job is still returned (not null).
      const second = await markProcessing('job_int_1');
      expect(second?.status).toBe('PROCESSING');
    });

    it('returns null once the job is terminal (SUCCEEDED)', async () => {
      await createJob(baseInput);
      await markSucceeded('job_int_1', { resultKeys: [`${TEST_UID}/job_int_1/0.webp`], providerUsed: 'nano-banana' });
      const res = await markProcessing('job_int_1');
      expect(res).toBeNull();
    });

    it('returns null for a missing job', async () => {
      const res = await markProcessing('does-not-exist');
      expect(res).toBeNull();
    });
  });

  it('markSucceeded sets resultKeys, providerUsed and status', async () => {
    await createJob(baseInput);
    await markSucceeded('job_int_1', {
      resultKeys: [`${TEST_UID}/job_int_1/0.webp`, `${TEST_UID}/job_int_1/1.webp`],
      providerUsed: 'nano-banana',
    });
    const job = await findJob('job_int_1');
    expect(job?.status).toBe('SUCCEEDED');
    expect(job?.providerUsed).toBe('nano-banana');
    expect(job?.resultKeys).toHaveLength(2);
  });

  it('markFailed sets error and creditsRefunded', async () => {
    await createJob(baseInput);
    await markFailed('job_int_1', { code: 'PROVIDER_ERROR', message: 'boom' }, { creditsRefunded: true });
    const job = await findJob('job_int_1');
    expect(job?.status).toBe('FAILED');
    expect(job?.error).toEqual({ code: 'PROVIDER_ERROR', message: 'boom' });
    expect(job?.creditsRefunded).toBe(true);
  });

  it('listJobsForUser returns newest-first and respects the limit', async () => {
    // Insert jobs with increasing createdAt by inserting sequentially.
    for (let i = 0; i < 3; i += 1) {
      await createJob({ ...baseInput, jobId: `job_${i}` });
      // Ensure distinct createdAt ordering.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 5));
    }

    const all = await listJobsForUser(TEST_UID);
    expect(all.map((j) => j.jobId)).toEqual(['job_2', 'job_1', 'job_0']);

    const limited = await listJobsForUser(TEST_UID, 2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.jobId).toBe('job_2');

    // Scoped to the user.
    expect(await listJobsForUser('other-user')).toEqual([]);
  });
});
