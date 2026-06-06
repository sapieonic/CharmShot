import { randomUUID, createHash } from 'node:crypto';

/** Generates a collision-resistant job id. */
export function newJobId(): string {
  return `job_${randomUUID().replace(/-/g, '')}`;
}

/** Stable hash of an arbitrary payload, used for webhook idempotency. */
export function hashPayload(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Sanitises a user-provided file name to a safe S3 path segment. */
export function safeFileName(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return cleaned.length > 0 ? cleaned : 'file';
}
