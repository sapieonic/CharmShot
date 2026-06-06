import { collections } from '../db/mongo';
import type { AuditLogRecord } from '../shared/types';
import { rootLogger } from '../shared/logger';

/**
 * Append an audit log entry. Best-effort: a failure here must never break the
 * primary request, so errors are logged and swallowed.
 */
export async function audit(entry: { uid?: string; action: string; meta?: Record<string, unknown> }): Promise<void> {
  try {
    const { auditLogs } = await collections();
    const doc: AuditLogRecord = {
      action: entry.action,
      createdAt: new Date(),
      ...(entry.uid ? { uid: entry.uid } : {}),
      ...(entry.meta ? { meta: entry.meta } : {}),
    };
    await auditLogs.insertOne(doc);
  } catch (err) {
    rootLogger.warn('Failed to write audit log', { action: entry.action, error: String(err) });
  }
}
