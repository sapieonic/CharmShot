/**
 * Application error model.
 *
 * Every error surfaced to a client is serialised into a consistent shape:
 *   { "error": { "code": "...", "message": "...", "details": ... } }
 */

export type ErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INSUFFICIENT_CREDITS'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'PROVIDER_ERROR'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  INSUFFICIENT_CREDITS: 402,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;
  /** When true, the original message is safe to expose to clients. */
  public readonly expose: boolean;

  constructor(code: ErrorCode, message: string, opts?: { details?: unknown; expose?: boolean; cause?: unknown }) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = opts?.details;
    this.expose = opts?.expose ?? true;
    if (opts?.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }

  toErrorBody(): { error: { code: ErrorCode; message: string; details?: unknown } } {
    return {
      error: {
        code: this.code,
        message: this.expose ? this.message : 'An unexpected error occurred.',
        ...(this.details !== undefined ? { details: this.details } : {}),
      },
    };
  }
}

// Convenience constructors -------------------------------------------------

export const Errors = {
  unauthorized: (message = 'Authentication required.', details?: unknown) =>
    new AppError('UNAUTHORIZED', message, { details }),
  forbidden: (message = 'Forbidden.', details?: unknown) => new AppError('FORBIDDEN', message, { details }),
  invalidInput: (message = 'Invalid input.', details?: unknown) =>
    new AppError('INVALID_INPUT', message, { details }),
  notFound: (message = 'Resource not found.', details?: unknown) => new AppError('NOT_FOUND', message, { details }),
  conflict: (message = 'Conflict.', details?: unknown) => new AppError('CONFLICT', message, { details }),
  rateLimited: (message = 'Too many requests.', details?: unknown) =>
    new AppError('RATE_LIMITED', message, { details }),
  insufficientCredits: (message = 'Insufficient credits.', details?: unknown) =>
    new AppError('INSUFFICIENT_CREDITS', message, { details }),
  payloadTooLarge: (message = 'Payload too large.', details?: unknown) =>
    new AppError('PAYLOAD_TOO_LARGE', message, { details }),
  unsupportedMediaType: (message = 'Unsupported media type.', details?: unknown) =>
    new AppError('UNSUPPORTED_MEDIA_TYPE', message, { details }),
  providerError: (message = 'Image provider failed.', details?: unknown) =>
    new AppError('PROVIDER_ERROR', message, { details, expose: false }),
  internal: (message = 'Internal error.', cause?: unknown) =>
    new AppError('INTERNAL', message, { expose: false, cause }),
};

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new AppError('INTERNAL', err.message, { expose: false, cause: err });
  return new AppError('INTERNAL', 'Unknown error', { expose: false, cause: err });
}
