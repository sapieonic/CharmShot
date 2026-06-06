/**
 * Generation service (API side).
 *
 * Orchestrates the synchronous part of job creation:
 *   1. Validate preset + reference keys (must belong to the user).
 *   2. Atomically reserve credits (1 credit per requested image).
 *   3. Persist a PENDING job.
 *   4. Enqueue async work to the in-process background worker.
 *
 * The heavy lifting (model calls, S3 writes) happens in the worker. This module
 * is provider-agnostic — it never references a concrete provider, only a
 * modelId that the worker resolves via the factory/strategy.
 */

import { config } from '../config/env';
import { keyBelongsToUser, presignResult } from '../aws/s3';
import { enqueueGenerationJob } from '../queue/jobQueue';
import { newJobId } from '../shared/ids';
import { Errors } from '../shared/errors';
import { emitMetric } from '../shared/metrics';
import type { Logger } from '../shared/logger';
import type { JobRecord, JobStatusResult } from '../shared/types';
import { getPreset } from '../presets/presets';
import { createJob, findJobForUser } from '../repositories/jobRepository';
import { reserveCredits, refundCredits } from '../repositories/entitlementRepository';
import { audit } from '../repositories/auditLogRepository';
import type { CreateGenerationRequest } from '../validation/schemas';

export interface CreateGenerationResult {
  jobId: string;
  status: 'PENDING';
}

export async function createGeneration(
  uid: string,
  input: CreateGenerationRequest,
  logger: Logger,
): Promise<CreateGenerationResult> {
  // 1. Preset must exist.
  const preset = getPreset(input.presetId);
  if (!preset) {
    throw Errors.invalidInput(`Unknown presetId: ${input.presetId}`);
  }

  // 2. All reference keys must live under this user's prefix.
  for (const key of input.referenceImageKeys) {
    if (!keyBelongsToUser(key, uid)) {
      throw Errors.forbidden('Reference image key does not belong to the authenticated user', { key });
    }
  }

  const modelId = input.modelId ?? config.providers.defaultModelId;
  const creditsRequired = input.count; // 1 credit per generated image.

  // 3. Reserve credits atomically BEFORE creating the job.
  const reserved = await reserveCredits(uid, creditsRequired);
  if (!reserved) {
    throw Errors.insufficientCredits('Not enough credits for this generation', {
      required: creditsRequired,
    });
  }
  emitMetric('credits_reserved', creditsRequired);

  const jobId = newJobId();
  const jobLogger = logger.child({ jobId });

  // 4. Persist job. If this fails, refund the reserved credits.
  try {
    await createJob({
      jobId,
      uid,
      presetId: input.presetId,
      modelId,
      count: input.count,
      referenceImageKeys: input.referenceImageKeys,
      creditsReserved: creditsRequired,
      aspectRatio: input.aspectRatio,
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    });
  } catch (err) {
    await refundCredits(uid, creditsRequired);
    emitMetric('credits_refunded', creditsRequired);
    throw Errors.internal('Failed to persist generation job', err);
  }

  // 5. Enqueue async work. If enqueue fails, mark the job failed + refund.
  try {
    await enqueueGenerationJob({ jobId, uid });
  } catch (err) {
    await refundCredits(uid, creditsRequired);
    emitMetric('credits_refunded', creditsRequired);
    // Best-effort fail marking; job stays queryable as FAILED.
    const { markFailed } = await import('../repositories/jobRepository');
    await markFailed(jobId, { code: 'ENQUEUE_FAILED', message: 'Could not enqueue job' }, { creditsRefunded: true });
    throw Errors.internal('Failed to enqueue generation job', err);
  }

  emitMetric('jobs_created', 1, { dimensions: { model: modelId } });
  await audit({ uid, action: 'generation.created', meta: { jobId, presetId: input.presetId, count: input.count } });
  jobLogger.info('Generation job created', { presetId: input.presetId, count: input.count, modelId });

  return { jobId, status: 'PENDING' };
}

/**
 * Read a job's status for its owner, returning short-lived signed URLs for any
 * completed results. Throws NOT_FOUND if the job doesn't exist for this user.
 */
export async function getGenerationStatus(uid: string, jobId: string): Promise<JobStatusResult> {
  const job = await findJobForUser(jobId, uid);
  if (!job) throw Errors.notFound('Job not found');
  return toStatusResult(job);
}

async function toStatusResult(job: JobRecord): Promise<JobStatusResult> {
  const results =
    job.status === 'SUCCEEDED'
      ? await Promise.all(
          job.resultKeys.map(async (key, index) => ({ index, url: await presignResult(key) })),
        )
      : [];

  return {
    jobId: job.jobId,
    status: job.status,
    presetId: job.presetId,
    count: job.count,
    ...(job.providerUsed ? { modelUsed: job.providerUsed } : { modelUsed: job.modelId }),
    results,
    ...(job.error ? { error: job.error } : {}),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}
