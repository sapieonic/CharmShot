import { collections } from '../db/mongo';
import type { JobRecord, JobStatus } from '../shared/types';

export interface NewJobInput {
  jobId: string;
  uid: string;
  presetId: string;
  modelId: string;
  count: number;
  referenceImageKeys: string[];
  creditsReserved: number;
  aspectRatio?: string;
  seed?: number;
}

export async function createJob(input: NewJobInput): Promise<JobRecord> {
  const { jobs } = await collections();
  const now = new Date();
  const job: JobRecord = {
    jobId: input.jobId,
    uid: input.uid,
    presetId: input.presetId,
    modelId: input.modelId,
    count: input.count,
    status: 'PENDING',
    referenceImageKeys: input.referenceImageKeys,
    resultKeys: [],
    creditsReserved: input.creditsReserved,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
    createdAt: now,
    updatedAt: now,
  };
  await jobs.insertOne(job);
  return job;
}

/** Fetch a job scoped to its owner so users can't read other users' jobs. */
export async function findJobForUser(jobId: string, uid: string): Promise<JobRecord | null> {
  const { jobs } = await collections();
  return jobs.findOne({ jobId, uid });
}

export async function findJob(jobId: string): Promise<JobRecord | null> {
  const { jobs } = await collections();
  return jobs.findOne({ jobId });
}

/**
 * Transition a job to PROCESSING only if it is currently PENDING. Returns the
 * updated job, or null if the transition wasn't applicable (idempotency guard
 * for at-least-once SQS delivery).
 */
export async function markProcessing(jobId: string): Promise<JobRecord | null> {
  const { jobs } = await collections();
  const res = await jobs.findOneAndUpdate(
    { jobId, status: { $in: ['PENDING', 'PROCESSING'] } },
    { $set: { status: 'PROCESSING' as JobStatus, updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
  return res ?? null;
}

export async function markSucceeded(
  jobId: string,
  data: { resultKeys: string[]; providerUsed: string },
): Promise<void> {
  const { jobs } = await collections();
  await jobs.updateOne(
    { jobId },
    {
      $set: {
        status: 'SUCCEEDED' as JobStatus,
        resultKeys: data.resultKeys,
        providerUsed: data.providerUsed,
        updatedAt: new Date(),
      },
    },
  );
}

export async function markFailed(
  jobId: string,
  error: { code: string; message: string },
  opts?: { creditsRefunded?: boolean },
): Promise<void> {
  const { jobs } = await collections();
  await jobs.updateOne(
    { jobId },
    {
      $set: {
        status: 'FAILED' as JobStatus,
        error,
        ...(opts?.creditsRefunded !== undefined ? { creditsRefunded: opts.creditsRefunded } : {}),
        updatedAt: new Date(),
      },
    },
  );
}

export async function listJobsForUser(uid: string, limit = 50): Promise<JobRecord[]> {
  const { jobs } = await collections();
  return jobs.find({ uid }).sort({ createdAt: -1 }).limit(limit).toArray();
}
