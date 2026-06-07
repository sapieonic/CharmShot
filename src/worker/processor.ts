/**
 * Worker-side generation processing. Provider-agnostic: it builds a prompt from
 * the preset, hands a generic request to the provider strategy, persists the
 * outputs to S3, and updates the job in MongoDB.
 *
 * Failure semantics:
 *  - Business failure (provider exhausted, no preset, etc.): the job is marked
 *    FAILED, reserved credits are refunded (if configured), and we return
 *    normally so the SQS message is deleted.
 *  - Infrastructure failure (DB/S3 unavailable, claim error): the error
 *    propagates so the SQS handler reports a batch-item failure → retry → DLQ.
 */

import { config } from '../config/env';
import { getUploadBytes, putResult, resultKey } from '../aws/s3';
import { Logger } from '../shared/logger';
import { emitMetric } from '../shared/metrics';
import { markActiveSpanError, setActiveSpanAttributes, withSpan } from '../shared/tracing';
import { toAppError } from '../shared/errors';
import { getPreset } from '../presets/presets';
import { findJob, markFailed, markProcessing, markSucceeded } from '../repositories/jobRepository';
import { refundCredits } from '../repositories/entitlementRepository';
import { audit } from '../repositories/auditLogRepository';
import { executeWithStrategy } from '../providers/strategy';
import type { ReferenceImage } from '../providers/types';

export async function processGenerationJob(jobId: string, baseLogger: Logger): Promise<void> {
  const logger = baseLogger.child({ jobId });

  // Claim the job (PENDING → PROCESSING). If we can't claim it, another
  // delivery already handled it or it's terminal — skip safely.
  const job = await markProcessing(jobId);
  if (!job) {
    const existing = await findJob(jobId);
    logger.info('Skipping job (not claimable)', { currentStatus: existing?.status ?? 'MISSING' });
    return;
  }

  const jobLogger = logger.child({ uid: job.uid });
  jobLogger.info('Processing generation job', { presetId: job.presetId, count: job.count });

  // Enrich the surrounding job span (opened by the queue) with business context.
  setActiveSpanAttributes({
    'job.preset_id': job.presetId,
    'job.count': job.count,
    'job.model_id': job.modelId,
    'job.reference_count': job.referenceImageKeys.length,
  });

  try {
    const preset = getPreset(job.presetId);
    if (!preset) {
      throw toAppError(new Error(`Preset no longer exists: ${job.presetId}`));
    }

    // Fetch reference images from S3.
    const referenceImages: ReferenceImage[] = await withSpan(
      'references.fetch',
      () =>
        Promise.all(
          job.referenceImageKeys.map(async (key) => ({
            data: await getUploadBytes(key),
            contentType: inferContentType(key),
            sourceKey: key,
          })),
        ),
      { attributes: { 'reference.count': job.referenceImageKeys.length } },
    );

    // Run generation through the provider strategy (primary → fallback).
    const { images, providerUsed } = await executeWithStrategy(
      {
        referenceImages,
        prompt: preset.promptTemplate,
        count: job.count,
        stylePreset: preset.id,
        aspectRatio: job.aspectRatio ?? '1:1',
        ...(job.seed !== undefined ? { seed: job.seed } : {}),
      },
      {
        requestedModelId: job.modelId,
        logger: jobLogger,
        ai: { distinctId: job.uid, traceId: job.jobId, properties: { presetId: job.presetId, count: job.count } },
      },
    );

    // Persist outputs to user/job-scoped result keys.
    const resultKeys: string[] = [];
    await withSpan(
      'results.persist',
      () =>
        Promise.all(
          images.map(async (img, index) => {
            const key = resultKey(job.uid, job.jobId, index, img.extension);
            await putResult({ key, body: img.data, contentType: img.contentType });
            resultKeys[index] = key;
          }),
        ),
      { attributes: { 'result.count': images.length } },
    );

    await markSucceeded(job.jobId, { resultKeys, providerUsed });
    setActiveSpanAttributes({ 'job.outcome': 'succeeded', 'job.provider_used': providerUsed });
    emitMetric('jobs_succeeded', 1, { dimensions: { provider: providerUsed }, distinctId: job.uid });
    await audit({ uid: job.uid, action: 'generation.succeeded', meta: { jobId: job.jobId, providerUsed } });
    jobLogger.info('Generation job succeeded', { providerUsed, results: resultKeys.length });
  } catch (err) {
    const appErr = toAppError(err);
    const refund = config.credits.refundOnFailure && job.creditsReserved > 0;
    if (refund) {
      await refundCredits(job.uid, job.creditsReserved);
      emitMetric('credits_refunded', job.creditsReserved, { distinctId: job.uid });
    }
    await markFailed(
      job.jobId,
      { code: appErr.code, message: appErr.expose ? appErr.message : 'Generation failed' },
      { creditsRefunded: refund },
    );
    emitMetric('jobs_failed', 1, { dimensions: { model: job.modelId }, distinctId: job.uid });
    // The business failure is caught here (not rethrown), so mark the span
    // failed explicitly — otherwise the trace would look successful.
    setActiveSpanAttributes({ 'job.outcome': 'failed', 'error.code': appErr.code });
    markActiveSpanError(appErr);
    await audit({ uid: job.uid, action: 'generation.failed', meta: { jobId: job.jobId, code: appErr.code } });
    jobLogger.error('Generation job failed', appErr, { refunded: refund });
    // Terminal: do NOT rethrow. Message is deleted; failure is recorded.
  }
}

function inferContentType(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}
