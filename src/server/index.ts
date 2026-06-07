/**
 * Server entrypoint.
 *
 * Starts the Fastify HTTP API and the in-process background worker in a single
 * long-lived process. On boot it connects to MongoDB (ensuring indexes) and
 * recovers any unfinished jobs, then listens for requests. Handles SIGINT/
 * SIGTERM for graceful shutdown (stop accepting connections, drain in-flight
 * jobs, close the DB).
 */

import { config } from '../config/env';
import { buildApp } from './app';
import { getDb, closeClient } from '../db/mongo';
import { jobQueue } from '../queue/jobQueue';
import { recoverUnfinishedJobs, startWorker } from '../worker';
import { rootLogger } from '../shared/logger';
import { startTelemetry, shutdownTelemetry } from '../shared/telemetry';
import { startTracing, shutdownTracing } from '../shared/tracing';
import { shutdownPostHog } from '../shared/posthog';

async function main(): Promise<void> {
  // Start OTLP log shipping + tracing (both no-ops unless configured) before
  // anything logs or runs, so boot logs/spans are captured too.
  startTelemetry();
  startTracing();

  // Establish the DB connection + indexes up front so the first request is fast
  // and startup fails loudly if Mongo is unreachable.
  await getDb();

  if (config.worker.enabled) {
    startWorker();
    await recoverUnfinishedJobs();
  }

  const app = buildApp();
  await app.listen({ port: config.server.port, host: config.server.host });
  rootLogger.info('CharmShot API listening', {
    port: config.server.port,
    host: config.server.host,
    workerEnabled: config.worker.enabled,
    workerConcurrency: config.worker.concurrency,
  });

  const shutdown = async (signal: string): Promise<void> => {
    rootLogger.info('Shutting down', { signal });
    let exitCode = 0;
    try {
      await app.close(); // stop accepting new connections
      await jobQueue.onIdle(); // let in-flight jobs finish
      await closeClient();
      rootLogger.info('Shutdown complete');
    } catch (err) {
      rootLogger.error('Error during shutdown', err);
      exitCode = 1;
    } finally {
      // Flush analytics/log buffers on BOTH paths so prior logs/events (incl.
      // any shutdown error logged above) are shipped before we exit.
      await shutdownPostHog();
      await shutdownTelemetry();
      await shutdownTracing();
    }
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  rootLogger.error('Fatal startup error', err);
  process.exit(1);
});
