/**
 * Background worker bootstrap.
 *
 * Wires the in-process job queue to the generation processor and recovers any
 * jobs that were left unfinished by a previous process (since the queue is
 * in-memory, a restart would otherwise strand PENDING/PROCESSING jobs).
 */

import { jobQueue } from '../queue/jobQueue';
import { processGenerationJob } from './processor';
import { findUnfinishedJobs } from '../repositories/jobRepository';
import { rootLogger } from '../shared/logger';

/** Register the processor so enqueued jobs start running. Idempotent. */
export function startWorker(): void {
  if (jobQueue.hasProcessor()) return;
  jobQueue.setProcessor(processGenerationJob);
  rootLogger.info('In-process generation worker started');
}

/**
 * Re-enqueue jobs that are still PENDING/PROCESSING in MongoDB. Safe to call at
 * startup; `markProcessing` guards against double-processing.
 */
export async function recoverUnfinishedJobs(): Promise<number> {
  const jobs = await findUnfinishedJobs();
  for (const job of jobs) {
    jobQueue.enqueue({ jobId: job.jobId, uid: job.uid });
  }
  if (jobs.length > 0) {
    rootLogger.info('Recovered unfinished generation jobs', { count: jobs.length });
  }
  return jobs.length;
}
