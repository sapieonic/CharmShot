/**
 * Entitlement service: read the caller's plan + remaining credits.
 */

import { getOrCreateEntitlement } from '../repositories/entitlementRepository';

export interface EntitlementView {
  plan: string;
  creditsRemaining: number;
  entitlementActive: boolean;
  lastSyncedAt: string;
}

export async function getEntitlements(uid: string): Promise<EntitlementView> {
  const e = await getOrCreateEntitlement(uid);
  return {
    plan: e.plan,
    creditsRemaining: e.creditsRemaining,
    entitlementActive: e.entitlementActive,
    lastSyncedAt: e.lastSyncedAt.toISOString(),
  };
}
