/**
 * AWS Lambda entrypoint for the HTTP API. Adapts an API Gateway HTTP API (v2)
 * proxy event into the framework-agnostic HttpRequest, dispatches it, and maps
 * the HttpResponse back to the Lambda result shape.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { bootstrapProviders } from '../providers';
import { dispatch } from './router';
import type { HttpRequest } from '../http/apiTypes';

// Register providers once per container.
bootstrapProviders();

function parseBody(event: APIGatewayProxyEventV2): { body: unknown; rawBody: string } {
  if (!event.body) return { body: undefined, rawBody: '' };
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf-8') : event.body;
  const contentType = headerValue(event.headers, 'content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return { body: JSON.parse(raw), rawBody: raw };
    } catch {
      return { body: undefined, rawBody: raw };
    }
  }
  return { body: raw, rawBody: raw };
}

function headerValue(headers: APIGatewayProxyEventV2['headers'], name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

function normaliseHeaders(headers: APIGatewayProxyEventV2['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (v !== undefined) out[k.toLowerCase()] = v;
  }
  return out;
}

function definedRecord(input: Record<string, string | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function handler(
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyResultV2> {
  const { body, rawBody } = parseBody(event);

  // routeKey is "METHOD /path/{param}"; "$default" means unmatched.
  const routeKey = event.routeKey && event.routeKey !== '$default'
    ? event.routeKey
    : `${event.requestContext.http.method} ${event.requestContext.http.path}`;
  const [method, routePath] = splitRouteKey(routeKey, event.requestContext.http.method, event.rawPath);

  const req: HttpRequest = {
    method,
    routePath,
    rawPath: event.rawPath,
    headers: normaliseHeaders(event.headers),
    pathParameters: definedRecord(event.pathParameters),
    query: definedRecord(event.queryStringParameters),
    body,
    rawBody,
    requestId: context.awsRequestId ?? event.requestContext.requestId,
  };

  const res = await dispatch(req);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    body: res.body,
  };
}

function splitRouteKey(routeKey: string, fallbackMethod: string, fallbackPath: string): [string, string] {
  const space = routeKey.indexOf(' ');
  if (space === -1) return [fallbackMethod, fallbackPath];
  return [routeKey.slice(0, space), routeKey.slice(space + 1)];
}
