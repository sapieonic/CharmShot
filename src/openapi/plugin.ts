/**
 * Registers API documentation routes on a Fastify instance:
 *   - GET /docs          interactive Swagger UI
 *   - GET /docs/json     spec served by swagger-ui
 *   - GET /openapi.json  the raw OpenAPI 3.1 document (stable path for tooling)
 *
 * The spec is provided statically from `buildOpenApiDocument()` (generated from
 * the zod schemas). Registrations are queued synchronously so they load in the
 * correct order during the server's boot (`listen()`), without prematurely
 * triggering `ready()`.
 */

import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { buildOpenApiDocument } from './document';

export function registerDocs(app: FastifyInstance): void {
  const document = buildOpenApiDocument();

  void app.register(swagger, {
    mode: 'static',
    specification: { document: document as never },
  });

  void app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  // Stable, unauthenticated raw spec endpoint.
  app.get('/openapi.json', async (_req, reply) => {
    reply.header('content-type', 'application/json');
    return document;
  });
}
