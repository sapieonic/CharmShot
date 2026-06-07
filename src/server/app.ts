/**
 * Fastify application factory.
 *
 * The HTTP layer is intentionally thin: Fastify handles transport (parsing,
 * body limits, connection lifecycle) and delegates every route to the existing
 * framework-agnostic router (`dispatch`), which owns auth, validation, rate
 * limiting, and routing. This keeps services/handlers identical to what the
 * (now removed) Lambda adapter used.
 */

import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type HTTPMethods,
} from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env';
import { dispatch } from '../api/router';
import { bootstrapProviders } from '../providers';
import { registerDocs } from '../openapi/plugin';
import type { HttpRequest } from '../http/apiTypes';

// Route templates so we can extract path parameters (e.g. {jobId}) consistently
// with how API Gateway used to present them to the router.
const ROUTES: { method: HTTPMethods; path: string }[] = [
  { method: 'POST', path: '/v1/uploads/presign' },
  { method: 'POST', path: '/v1/generations' },
  { method: 'GET', path: '/v1/generations/:jobId' },
  { method: 'GET', path: '/v1/presets' },
  { method: 'GET', path: '/v1/me/entitlements' },
  { method: 'POST', path: '/v1/webhooks/razorpay' },
  { method: 'GET', path: '/health' },
];

/** Fastify uses ":param"; the internal router uses "{param}". */
function toRoutePath(fastifyPath: string): string {
  return fastifyPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function headersToRecord(headers: FastifyRequest['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
    else if (Array.isArray(v)) out[k.toLowerCase()] = v.join(',');
  }
  return out;
}

export function buildApp(): FastifyInstance {
  // Register image providers once.
  bootstrapProviders();

  const app = Fastify({
    bodyLimit: config.server.bodyLimitBytes,
    // We do our own structured logging; disable Fastify's default logger.
    logger: false,
    genReqId: () => randomUUID(),
  });

  // CORS: allow the browser frontend to call the API cross-origin. Registered
  // before routes so the plugin's onRequest hook answers preflight OPTIONS
  // (which the explicit GET/POST route table below would otherwise 404) and
  // attaches Access-Control-* headers to every response. `allowedOrigins`
  // comes from CORS_ALLOWED_ORIGINS (comma-separated); "*" allows any origin.
  const allowAnyOrigin = config.cors.allowedOrigins.includes('*');
  app.register(cors, {
    origin: allowAnyOrigin ? true : config.cors.allowedOrigins,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // Credentials are not used (auth is a bearer token, not cookies), so a
    // wildcard origin stays valid; leave credentials off.
    maxAge: 86400,
  });

  // Preserve the raw body so the Razorpay webhook can hash/verify it, while
  // still exposing parsed JSON. Fastify gives us the parsed body; we also keep
  // the raw string by adding a content type parser that retains it.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_req, body, done) => {
      const raw = body as string;
      try {
        const parsed = raw.length > 0 ? JSON.parse(raw) : undefined;
        // Stash raw on the request via a symbol-free property.
        (_req as FastifyRequest & { rawBody?: string }).rawBody = raw;
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const routePath = toRoutePath((req.routeOptions?.url ?? req.url.split('?')[0]) as string);
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody ?? '';

    const httpReq: HttpRequest = {
      method: req.method,
      routePath,
      rawPath: req.url.split('?')[0] ?? req.url,
      headers: headersToRecord(req.headers),
      pathParameters: (req.params as Record<string, string>) ?? {},
      query: (req.query as Record<string, string>) ?? {},
      body: req.body,
      rawBody,
      requestId: req.id,
    };

    const res = await dispatch(httpReq);
    reply.code(res.statusCode);
    if (res.headers) reply.headers(res.headers);
    // Body is already a serialized string from the router.
    reply.send(res.body === '' ? undefined : res.body);
  };

  for (const route of ROUTES) {
    app.route({ method: route.method, url: route.path, handler });
  }

  // API documentation: Swagger UI at /docs and the raw spec at /openapi.json.
  registerDocs(app);

  // Fallback: route unknown paths through the router so it returns the
  // consistent 404 error envelope.
  app.setNotFoundHandler(handler);

  return app;
}
