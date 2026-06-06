/**
 * Local development HTTP server. Mirrors the API Gateway → router contract so
 * the same handlers run locally. Not used in production (Lambda + API Gateway
 * are the real entrypoints). Run with: npm run dev:api
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { bootstrapProviders } from '../providers';
import { dispatch } from '../api/router';
import { rootLogger } from '../shared/logger';
import type { HttpRequest } from '../http/apiTypes';

bootstrapProviders();

// Route templates used to extract path parameters locally.
const ROUTE_TEMPLATES: { method: string; template: string; regex: RegExp; params: string[] }[] = [
  '/v1/uploads/presign',
  '/v1/generations',
  '/v1/generations/{jobId}',
  '/v1/presets',
  '/v1/me/entitlements',
  '/v1/webhooks/revenuecat',
  '/health',
].flatMap((template) =>
  ['GET', 'POST', 'PUT', 'DELETE'].map((method) => {
    const params: string[] = [];
    const regex = new RegExp(
      '^' +
        template.replace(/\{([^}]+)\}/g, (_m, p) => {
          params.push(p);
          return '([^/]+)';
        }) +
        '/?$',
    );
    return { method, template, regex, params };
  }),
);

function matchRoute(method: string, path: string): { routePath: string; params: Record<string, string> } {
  for (const route of ROUTE_TEMPLATES) {
    if (route.method !== method) continue;
    const m = route.regex.exec(path);
    if (m) {
      const params: Record<string, string> = {};
      route.params.forEach((p, i) => {
        params[p] = decodeURIComponent(m[i + 1] ?? '');
      });
      return { routePath: route.template, params };
    }
  }
  return { routePath: path, params: {} };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';
    const { routePath, params } = matchRoute(method, url.pathname);
    const rawBody = await readBody(req);

    let body: unknown;
    const contentType = String(req.headers['content-type'] ?? '');
    if (contentType.includes('application/json') && rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = undefined;
      }
    } else {
      body = rawBody || undefined;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(',');
    }

    const httpReq: HttpRequest = {
      method,
      routePath,
      rawPath: url.pathname,
      headers,
      pathParameters: params,
      query: Object.fromEntries(url.searchParams.entries()),
      body,
      rawBody,
      requestId: randomUUID(),
    };

    const result = await dispatch(httpReq);
    res.writeHead(result.statusCode, result.headers);
    res.end(result.body);
  } catch (err) {
    rootLogger.error('Local server error', err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal error' } }));
  }
});

const port = Number(process.env.PORT ?? 3000);
server.listen(port, () => {
  rootLogger.info(`CharmShot local API listening on http://localhost:${port}`);
});
