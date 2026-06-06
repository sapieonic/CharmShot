/**
 * Minimal route dispatcher shared by the Lambda entrypoint and the local dev
 * server. Routes are matched by "METHOD routePath". Authenticated routes are
 * wrapped with Firebase verification + per-uid rate limiting; the webhook route
 * is public (secret-header auth handled inside its handler).
 */

import { rootLogger } from '../shared/logger';
import { Errors } from '../shared/errors';
import { errorResponse } from '../http/responses';
import type { HttpRequest, HttpResponse, RouteHandler, PublicRouteHandler } from '../http/apiTypes';
import { authenticate } from '../services/authService';
import { extractBearerToken } from '../auth/firebase';
import { enforceRateLimit } from '../middleware/rateLimit';
import {
  handleCreateGeneration,
  handleGetEntitlements,
  handleGetGeneration,
  handleListPresets,
  handlePresign,
} from './handlers';
import { handleRevenueCatWebhook } from './webhookHandler';

const authedRoutes: Record<string, RouteHandler> = {
  'POST /v1/uploads/presign': handlePresign,
  'POST /v1/generations': handleCreateGeneration,
  'GET /v1/generations/{jobId}': handleGetGeneration,
  'GET /v1/presets': handleListPresets,
  'GET /v1/me/entitlements': handleGetEntitlements,
};

const publicRoutes: Record<string, PublicRouteHandler> = {
  'POST /v1/webhooks/revenuecat': handleRevenueCatWebhook,
  'GET /health': async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'ok' }) }),
};

export async function dispatch(req: HttpRequest): Promise<HttpResponse> {
  const key = `${req.method} ${req.routePath}`;
  const logger = rootLogger.child({ requestId: req.requestId, route: key });

  // Public routes first (no Firebase auth).
  const publicHandler = publicRoutes[key];
  if (publicHandler) {
    try {
      return await publicHandler(req, logger);
    } catch (err) {
      return errorResponse(err, logger);
    }
  }

  const handler = authedRoutes[key];
  if (!handler) {
    return errorResponse(Errors.notFound(`No route for ${key}`), logger);
  }

  try {
    const token = extractBearerToken(req.headers['authorization']);
    const user = await authenticate(token);
    await enforceRateLimit(user.uid);
    const ctx = { user, logger: logger.child({ uid: user.uid }) };
    return await handler(req, ctx);
  } catch (err) {
    return errorResponse(err, logger);
  }
}
