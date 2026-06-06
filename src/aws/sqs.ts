/**
 * SQS producer for asynchronous generation work.
 */

import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { config } from '../config/env';

const client = new SQSClient({ region: config.region });

/** Message body enqueued for the worker Lambda. */
export interface GenerationJobMessage {
  jobId: string;
  uid: string;
}

export async function enqueueGenerationJob(message: GenerationJobMessage): Promise<void> {
  if (!config.sqs.generationQueueUrl) {
    throw new Error('GENERATION_QUEUE_URL is not configured');
  }
  await client.send(
    new SendMessageCommand({
      QueueUrl: config.sqs.generationQueueUrl,
      MessageBody: JSON.stringify(message),
      // Group by uid to keep a user's jobs in order if a FIFO queue is used.
      MessageAttributes: {
        uid: { DataType: 'String', StringValue: message.uid },
        jobId: { DataType: 'String', StringValue: message.jobId },
      },
    }),
  );
}
