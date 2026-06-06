/**
 * SQS-triggered worker Lambda. Consumes generation job messages, processing
 * each independently. Uses partial batch responses so that only genuinely
 * failed (thrown) messages are retried / sent to the DLQ.
 */

import type { Context, SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import { bootstrapProviders } from '../providers';
import { rootLogger } from '../shared/logger';
import { processGenerationJob } from './processor';
import type { GenerationJobMessage } from '../aws/sqs';

bootstrapProviders();

export async function handler(event: SQSEvent, context: Context): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const logger = rootLogger.child({
      requestId: context.awsRequestId,
      messageId: record.messageId,
    });
    try {
      const message = parseMessage(record);
      await processGenerationJob(message.jobId, logger);
    } catch (err) {
      // Infrastructure error → let SQS retry; eventually routed to DLQ.
      logger.error('Worker failed to process message; will retry', err);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

function parseMessage(record: SQSRecord): GenerationJobMessage {
  const parsed = JSON.parse(record.body) as Partial<GenerationJobMessage>;
  if (!parsed.jobId || !parsed.uid) {
    throw new Error(`Malformed generation message: ${record.body}`);
  }
  return { jobId: parsed.jobId, uid: parsed.uid };
}
