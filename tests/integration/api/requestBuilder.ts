/**
 * Helpers for building framework-agnostic HttpRequest objects to drive the real
 * router (src/api/router.ts) in integration tests. Not a test file itself.
 */

import type { HttpRequest } from '../../../src/http/apiTypes';

let counter = 0;

export interface RequestOpts {
  method: string;
  routePath: string;
  rawPath?: string;
  headers?: Record<string, string>;
  pathParameters?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

export function buildRequest(opts: RequestOpts): HttpRequest {
  counter += 1;
  const rawBody = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : '');
  return {
    method: opts.method,
    routePath: opts.routePath,
    rawPath: opts.rawPath ?? opts.routePath,
    headers: opts.headers ?? {},
    pathParameters: opts.pathParameters ?? {},
    query: opts.query ?? {},
    body: opts.body,
    rawBody,
    requestId: `req-${counter}`,
  };
}

/** A request carrying a non-empty bearer token (authenticates via fakeVerifier). */
export function authedRequest(opts: RequestOpts): HttpRequest {
  return buildRequest({
    ...opts,
    headers: { authorization: 'Bearer test-token', ...(opts.headers ?? {}) },
  });
}

/** Parse a JSON response body. */
export function parseBody<T = unknown>(body: string): T {
  return JSON.parse(body) as T;
}
