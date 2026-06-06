/**
 * S3 access: presigned PUT URLs for uploads, presigned GET URLs for results,
 * and server-side object fetch/put used by the worker.
 *
 * S3 is the only external AWS dependency. Buckets are private and encrypted at
 * rest; clients never touch S3 directly except through short-lived signed URLs.
 * A custom endpoint (S3_ENDPOINT) can be set to point at an S3-compatible local
 * server such as MinIO or LocalStack during development.
 */

import { GetObjectCommand, PutObjectCommand, S3Client, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env';
import type { AllowedContentType } from '../validation/schemas';

const client = new S3Client({
  region: config.region,
  ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
  ...(config.s3.forcePathStyle ? { forcePathStyle: true } : {}),
});

/** Builds the user-scoped key for an uploaded reference image. */
export function uploadKey(uid: string, jobScope: string, fileName: string): string {
  return `${uid}/${jobScope}/${fileName}`;
}

/** Builds the user-scoped key for a generated result. */
export function resultKey(uid: string, jobId: string, index: number, ext = 'webp'): string {
  return `${uid}/${jobId}/${index}.${ext}`;
}

/** Returns true if the S3 key belongs to the given user (prefix check). */
export function keyBelongsToUser(key: string, uid: string): boolean {
  return key === uid || key.startsWith(`${uid}/`);
}

export interface PresignedUpload {
  uploadUrl: string;
  s3Key: string;
}

/**
 * Create a presigned PUT URL for an upload. The signed URL pins the
 * Content-Type so the client must use the same type it declared.
 */
export async function presignUpload(params: {
  key: string;
  contentType: AllowedContentType;
}): Promise<PresignedUpload> {
  // Encryption is enforced by the bucket's default-encryption policy (see CDK),
  // so we don't pin SSE headers here — that keeps the presigned PUT simple for
  // clients (no extra signed x-amz-server-side-encryption header required).
  const cmd = new PutObjectCommand({
    Bucket: config.s3.uploadsBucket,
    Key: params.key,
    ContentType: params.contentType,
  });
  const uploadUrl = await getSignedUrl(client, cmd, { expiresIn: config.s3.uploadUrlTtlSeconds });
  return { uploadUrl, s3Key: params.key };
}

/** Create a short-lived presigned GET URL for a result object. */
export async function presignDownload(bucket: string, key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return getSignedUrl(client, cmd, { expiresIn: config.s3.resultUrlTtlSeconds });
}

export function presignResult(key: string): Promise<string> {
  return presignDownload(config.s3.resultsBucket, key);
}

/** Server-side fetch of an object's bytes (used by the worker for references). */
export async function getObjectBytes(bucket: string, key: string): Promise<Buffer> {
  const res: GetObjectCommandOutput = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = res.Body;
  if (!body) throw new Error(`Empty body for s3://${bucket}/${key}`);
  const chunks: Buffer[] = [];
  // @ts-expect-error Node stream is async-iterable at runtime
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function getUploadBytes(key: string): Promise<Buffer> {
  return getObjectBytes(config.s3.uploadsBucket, key);
}

/** Server-side write of a generated result. */
export async function putResult(params: {
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  await client.send(
    new PutObjectCommand({
      Bucket: config.s3.resultsBucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
}
