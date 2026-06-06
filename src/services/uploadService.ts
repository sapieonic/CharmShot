/**
 * Upload service: produce presigned PUT URLs scoped to the user.
 *
 * Reference uploads land under s3://{uploadsBucket}/{uid}/{uploadScope}/{file}.
 * The uploadScope groups files for a future job; we generate one per presign
 * call so a batch of references shares a prefix.
 */

import { randomUUID } from 'node:crypto';
import { presignUpload, uploadKey, type PresignedUpload } from '../aws/s3';
import { safeFileName } from '../shared/ids';
import type { PresignRequest } from '../validation/schemas';

export async function createPresignedUpload(uid: string, input: PresignRequest): Promise<PresignedUpload> {
  const uploadScope = `uploads/${randomUUID().replace(/-/g, '')}`;
  const fileName = safeFileName(input.fileName);
  const key = uploadKey(uid, uploadScope, fileName);
  return presignUpload({ key, contentType: input.contentType });
}
