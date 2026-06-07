/**
 * Minimal route dispatcher shared by the Lambda entrypoint and the local dev
 * server. Routes are matched by "METHOD routePath". Authenticated routes are
 * wrapped with Firebase verification + per-uid rate limiting; the webhook route
 * is public (secret-header auth handled inside its handler).
 */

import { rootLogger, type Logger } from '../shared/logger';
import { extractContext, setActiveSpanAttributes, SpanKind, SpanStatusCode, withSpan } from '../shared/tracing';
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

  // Open a SERVER span for the whole request, continuing any inbound trace
  // (W3C `traceparent`) so calls from instrumented clients stay connected.
  return withSpan(
    `${req.method} ${req.routePath}`,
    async (span) => {
      const res = await route(req, key, logger);
      span.setAttribute('http.response.status_code', res.statusCode);
      // Server-side errors mark the span failed; 4xx are client problems, not
      // span errors, so they stay OK.
      if (res.statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${res.statusCode}` });
      }
      return res;
    },
    {
      kind: SpanKind.SERVER,
      parent: extractContext(req.headers),
      attributes: {
        'http.request.method': req.method,
        'http.route': req.routePath,
        'url.path': req.rawPath,
        'request.id': req.requestId,
      },
    },
  );
}

/** Resolve, authenticate, and run the handler, returning the error envelope on failure. */
async function route(req: HttpRequest, key: string, logger: Logger): Promise<HttpResponse> {
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
    // Tag the request span/trace with the authenticated user for correlation.
    setActiveSpanAttributes({ 'enduser.id': user.uid });
    const ctx = { user, logger: logger.child({ uid: user.uid }) };
    return await handler(req, ctx);
  } catch (err) {
    return errorResponse(err, logger);
  }
}
