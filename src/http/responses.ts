import { toAppError } from '../shared/errors';
import type { Logger } from '../shared/logger';
import type { HttpResponse } from './apiTypes';

const JSON_HEADERS = { 'content-type': 'application/json' };

export function json(statusCode: number, body: unknown, extraHeaders?: Record<string, string>): HttpResponse {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...(extraHeaders ?? {}) },
    body: JSON.stringify(body),
  };
}

export function ok(body: unknown): HttpResponse {
  return json(200, body);
}

export function created(body: unknown): HttpResponse {
  return json(201, body);
}

export function noContent(): HttpResponse {
  return { statusCode: 204, headers: {}, body: '' };
}

/**
 * Convert any thrown value into the consistent error envelope:
 *   { "error": { "code", "message", "details"? } }
 * Logs 5xx errors at error level, client errors at warn/debug.
 */
export function errorResponse(err: unknown, logger?: Logger): HttpResponse {
  const appErr = toAppError(err);
  if (appErr.statusCode >= 500) {
    logger?.error('Request failed', appErr, { code: appErr.code });
  } else {
    logger?.warn('Request rejected', { code: appErr.code, status: appErr.statusCode, message: appErr.message });
  }
  return json(appErr.statusCode, appErr.toErrorBody());
}
