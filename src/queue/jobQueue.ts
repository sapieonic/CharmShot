/**
 * In-process background job queue.
 *
 * Replaces SQS for the single-server deployment. `enqueueGenerationJob` hands a
 * job to an in-memory, concurrency-limited worker that runs inside the same
 * Node process as the HTTP server. The API responds immediately with a PENDING
 * job; this queue drives it to a terminal state in the background, and clients
 * poll GET /v1/generations/{jobId} for status.
 *
 * The queue is deliberately decoupled from the job logic: the server wires the
 * processor in at boot via `setProcessor`. If no processor is registered (e.g.
 * in unit/integration tests that drive the worker manually), enqueue simply
 * buffers messages and does no processing.
 *
 * Note: because this is in-memory, jobs queued but not yet processed are lost
 * if the process restarts. `recoverPendingJobs` (run at startup) re-enqueues
 * any jobs left PENDING in MongoDB so nothing is silently dropped.
 */

import { config } from '../config/env';
import { rootLogger, type Logger } from '../shared/logger';
import { linkFromCarrier, SpanKind, withSpan } from '../shared/tracing';

export interface GenerationJobMessage {
  jobId: string;
  uid: string;
  /**
   * W3C trace-context carrier captured when the job was enqueued, used to link
   * the job's processing span back to the request that created it. Absent for
   * recovered jobs (no originating request).
   */
  traceContext?: Record<string, string>;
}

export type JobProcessor = (jobId: string, logger: Logger) => Promise<void>;

export class InProcessJobQueue {
  private readonly pending: GenerationJobMessage[] = [];
  private active = 0;
  private processor: JobProcessor | undefined;
  private readonly concurrency: number;
  /** Resolvers waiting for the queue to fully drain (used by tests/shutdown). */
  private idleWaiters: (() => void)[] = [];

  constructor(concurrency = config.worker.concurrency) {
    this.concurrency = Math.max(1, concurrency);
  }

  /** Register the function that actually processes a job. */
  setProcessor(processor: JobProcessor): void {
    this.processor = processor;
    this.drain();
  }

  hasProcessor(): boolean {
    return this.processor !== undefined;
  }

  enqueue(message: GenerationJobMessage): void {
    this.pending.push(message);
    this.drain();
  }

  /** Resolves once all queued and in-flight jobs have completed. */
  async onIdle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  get size(): number {
    return this.pending.length;
  }

  private drain(): void {
    if (!this.processor) return;
    while (this.active < this.concurrency && this.pending.length > 0) {
      const message = this.pending.shift()!;
      this.active += 1;
      void this.runOne(message).finally(() => {
        this.active -= 1;
        if (this.active === 0 && this.pending.length === 0) {
          const waiters = this.idleWaiters;
          this.idleWaiters = [];
          for (const w of waiters) w();
        }
        this.drain();
      });
    }
  }

  private async runOne(message: GenerationJobMessage): Promise<void> {
    const logger = rootLogger.child({ jobId: message.jobId, uid: message.uid, component: 'worker' });
    // Root the job in its own CONSUMER span (the queue is the natural owner of
    // the "process this message" span), linked to the request that enqueued it.
    // `root: true` is essential: the queue drains synchronously inside the
    // enqueuing request's async context, so without it the job span would nest
    // under that request span instead of starting its own trace. Spans the
    // processor opens nest under this one.
    const link = message.traceContext ? linkFromCarrier(message.traceContext) : undefined;
    try {
      await withSpan(
        'worker.process_job',
        () => this.processor!(message.jobId, logger),
        {
          kind: SpanKind.CONSUMER,
          root: true,
          attributes: { 'job.id': message.jobId, 'enduser.id': message.uid },
          ...(link ? { links: [link] } : {}),
        },
      );
    } catch (err) {
      // Processor already records terminal failures; this guards against
      // unexpected throws so one bad job never crashes the worker loop.
      logger.error('Worker encountered an unhandled error processing job', err);
    }
  }
}

/** Process-wide singleton queue. */
export const jobQueue = new InProcessJobQueue();

/**
 * Enqueue a generation job. Kept async to preserve the call-site contract used
 * by the generation service (which treats enqueue failures as recoverable).
 */
export async function enqueueGenerationJob(message: GenerationJobMessage): Promise<void> {
  jobQueue.enqueue(message);
}
