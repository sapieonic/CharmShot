/**
 * Firebase ID token verification using the Firebase Admin SDK.
 *
 * The Admin app is initialised once per container. Credentials come from a
 * service-account JSON stored in Secrets Manager (production). For local dev,
 * if no service account is configured we still construct the app with just the
 * projectId, which is sufficient for the Admin SDK to verify ID tokens against
 * Google's public JWKS.
 *
 * Verified claims are normalised to { uid, email, name }.
 */

import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { config } from '../config/env';
import { Errors } from '../shared/errors';
import type { AuthenticatedUser } from '../shared/types';

let appPromise: Promise<App> | null = null;

interface ServiceAccountJson {
  project_id: string;
  client_email: string;
  private_key: string;
}

async function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = (async () => {
      const existing = getApps();
      if (existing.length > 0) return existing[0]!;

      if (config.firebase.serviceAccountJson) {
        const sa = JSON.parse(config.firebase.serviceAccountJson) as ServiceAccountJson;
        return initializeApp({
          credential: cert({
            projectId: sa.project_id,
            clientEmail: sa.client_email,
            // Env values often store the key with escaped newlines.
            privateKey: sa.private_key.replace(/\\n/g, '\n'),
          }),
          projectId: sa.project_id,
        });
      }

      // Local-dev / JWKS path: projectId is enough to verify public ID tokens.
      return initializeApp({ projectId: config.firebase.projectId });
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

/**
 * Verify a Firebase ID token string and return normalised user claims.
 * Throws AppError(UNAUTHORIZED) on any verification failure.
 */
export async function verifyIdToken(idToken: string): Promise<AuthenticatedUser> {
  if (!idToken || idToken.trim().length === 0) {
    throw Errors.unauthorized('Missing ID token');
  }
  try {
    const app = await getApp();
    const decoded = await getAuth(app).verifyIdToken(idToken);
    return {
      uid: decoded.uid,
      ...(decoded.email ? { email: decoded.email } : {}),
      ...(decoded.name ? { name: decoded.name as string } : {}),
    };
  } catch (err) {
    throw Errors.unauthorized('Invalid or expired ID token', { reason: String(err) });
  }
}

/** Extracts the bearer token from an Authorization header value. */
export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) throw Errors.unauthorized('Missing Authorization header');
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match || !match[1]) throw Errors.unauthorized('Authorization header must be "Bearer <token>"');
  return match[1].trim();
}

/** Test seam: allow injecting a fake verifier without real Firebase. */
export interface TokenVerifier {
  verifyIdToken(idToken: string): Promise<AuthenticatedUser>;
}

export const defaultVerifier: TokenVerifier = { verifyIdToken };
