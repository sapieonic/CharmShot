/**
 * Auth service: verify a Firebase ID token, upsert the user record, and ensure
 * a default entitlement exists. Returns normalised claims for the request.
 */

import { defaultVerifier, type TokenVerifier } from '../auth/firebase';
import { upsertUser } from '../repositories/userRepository';
import { getOrCreateEntitlement } from '../repositories/entitlementRepository';
import type { AuthenticatedUser } from '../shared/types';

export async function authenticate(
  idToken: string,
  verifier: TokenVerifier = defaultVerifier,
): Promise<AuthenticatedUser> {
  const user = await verifier.verifyIdToken(idToken);
  // Upsert user + ensure entitlement so downstream reads always have records.
  await upsertUser(user);
  await getOrCreateEntitlement(user.uid);
  return user;
}
