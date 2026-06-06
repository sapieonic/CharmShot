/**
 * Core domain types shared across services, repositories and providers.
 */

export type JobStatus = 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED';

export interface AuthenticatedUser {
  uid: string;
  email?: string;
  name?: string;
}

export interface UserRecord {
  uid: string;
  email?: string;
  name?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobRecord {
  jobId: string;
  uid: string;
  presetId: string;
  modelId: string;
  count: number;
  status: JobStatus;
  referenceImageKeys: string[];
  /** Provider id that actually produced the results (may differ via fallback). */
  providerUsed?: string;
  resultKeys: string[];
  /** Credits reserved for this job; used for refund-on-failure. */
  creditsReserved: number;
  creditsRefunded?: boolean;
  error?: { code: string; message: string };
  seed?: number;
  aspectRatio?: string;
  createdAt: Date;
  updatedAt: Date;
}

export type Plan = 'free' | 'pro' | 'premium' | string;

export interface EntitlementRecord {
  uid: string;
  plan: Plan;
  creditsRemaining: number;
  entitlementActive: boolean;
  lastSyncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface WebhookEventRecord {
  eventId: string;
  type: string;
  uid?: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface AuditLogRecord {
  uid?: string;
  action: string;
  meta?: Record<string, unknown>;
  createdAt: Date;
}

/** Result of a job-status read, with signed URLs for completed results. */
export interface JobStatusResult {
  jobId: string;
  status: JobStatus;
  presetId: string;
  count: number;
  modelUsed?: string;
  results: { index: number; url: string }[];
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}
