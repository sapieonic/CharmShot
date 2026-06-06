/**
 * Route handler implementations. Each is a thin adapter: parse/validate input,
 * call a service, shape the response. No business logic lives here.
 */

import { created, ok } from '../http/responses';
import type { AuthedContext, HttpRequest, HttpResponse } from '../http/apiTypes';
import {
  createGenerationSchema,
  jobIdParamSchema,
  parseOrThrow,
  presignRequestSchema,
} from '../validation/schemas';
import { createPresignedUpload } from '../services/uploadService';
import { createGeneration, getGenerationStatus } from '../services/generationService';
import { getEntitlements } from '../services/entitlementService';
import { getPresetViews } from '../services/presetService';

export async function handlePresign(req: HttpRequest, ctx: AuthedContext): Promise<HttpResponse> {
  const input = parseOrThrow(presignRequestSchema, req.body);
  const result = await createPresignedUpload(ctx.user.uid, input);
  return ok(result);
}

export async function handleCreateGeneration(req: HttpRequest, ctx: AuthedContext): Promise<HttpResponse> {
  const input = parseOrThrow(createGenerationSchema, req.body);
  const result = await createGeneration(ctx.user.uid, input, ctx.logger);
  return created(result);
}

export async function handleGetGeneration(req: HttpRequest, ctx: AuthedContext): Promise<HttpResponse> {
  const { jobId } = parseOrThrow(jobIdParamSchema, req.pathParameters);
  const result = await getGenerationStatus(ctx.user.uid, jobId);
  return ok(result);
}

export async function handleListPresets(_req: HttpRequest, _ctx: AuthedContext): Promise<HttpResponse> {
  return ok({ presets: getPresetViews() });
}

export async function handleGetEntitlements(_req: HttpRequest, ctx: AuthedContext): Promise<HttpResponse> {
  const result = await getEntitlements(ctx.user.uid);
  return ok(result);
}
