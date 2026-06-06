/**
 * Framework-agnostic HTTP request/response types used by the router. These map
 * cleanly to API Gateway HTTP API (v2) events but keep handlers testable
 * without constructing full Lambda events.
 */

import type { AuthenticatedUser } from '../shared/types';
import type { Logger } from '../shared/logger';

export interface HttpRequest {
  method: string;
  /** Route path, e.g. "/v1/generations/{jobId}". */
  routePath: string;
  /** Raw request path, e.g. "/v1/generations/job_abc". */
  rawPath: string;
  headers: Record<string, string>;
  pathParameters: Record<string, string>;
  query: Record<string, string>;
  /** Parsed JSON body (or undefined). */
  body: unknown;
  /** Raw (string) body, needed for webhook signature/hash verification. */
  rawBody: string;
  requestId: string;
}

export interface HttpResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: string;
}

/** Request augmented with the authenticated user + per-request logger. */
export interface AuthedContext {
  user: AuthenticatedUser;
  logger: Logger;
}

export type RouteHandler = (req: HttpRequest, ctx: AuthedContext) => Promise<HttpResponse>;
export type PublicRouteHandler = (req: HttpRequest, logger: Logger) => Promise<HttpResponse>;
