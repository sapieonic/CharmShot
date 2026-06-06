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

async function main(): Promise<void> {
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
    try {
      await app.close(); // stop accepting new connections
      await jobQueue.onIdle(); // let in-flight jobs finish
      await closeClient();
      rootLogger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      rootLogger.error('Error during shutdown', err);
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  rootLogger.error('Fatal startup error', err);
  process.exit(1);
});
