import { describe, expect, it } from 'vitest';
import { AppError, Errors, toAppError, type ErrorCode } from '../../../src/shared/errors';

describe('AppError', () => {
  it('maps each code to the documented HTTP status', () => {
    const expected: Record<ErrorCode, number> = {
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
    for (const [code, status] of Object.entries(expected)) {
      expect(new AppError(code as ErrorCode, 'x').statusCode).toBe(status);
    }
  });

  it('toErrorBody produces the { error: { code, message } } envelope', () => {
    const err = new AppError('NOT_FOUND', 'missing thing');
    expect(err.toErrorBody()).toEqual({
      error: { code: 'NOT_FOUND', message: 'missing thing' },
    });
  });

  it('includes details only when present', () => {
    const withDetails = new AppError('INVALID_INPUT', 'bad', { details: [{ path: 'a', message: 'm' }] });
    expect(withDetails.toErrorBody().error.details).toEqual([{ path: 'a', message: 'm' }]);

    const withoutDetails = new AppError('INVALID_INPUT', 'bad');
    expect('details' in withoutDetails.toErrorBody().error).toBe(false);
  });

  it('hides the message when expose is false', () => {
    const err = new AppError('INTERNAL', 'secret stack detail', { expose: false });
    expect(err.toErrorBody().error.message).toBe('An unexpected error occurred.');
    // The real message is still available internally.
    expect(err.message).toBe('secret stack detail');
  });

  it('exposes the message by default', () => {
    expect(new AppError('CONFLICT', 'dup').toErrorBody().error.message).toBe('dup');
  });

  it('is an instance of Error and carries a cause when provided', () => {
    const cause = new Error('root');
    const err = new AppError('INTERNAL', 'wrapped', { cause });
    expect(err).toBeInstanceOf(Error);
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });
});

describe('Errors convenience constructors', () => {
  it('providerError and internal are non-exposed', () => {
    expect(Errors.providerError('boom').expose).toBe(false);
    expect(Errors.internal('boom').expose).toBe(false);
  });

  it('client errors expose their message', () => {
    expect(Errors.invalidInput('bad field').expose).toBe(true);
    expect(Errors.notFound().code).toBe('NOT_FOUND');
    expect(Errors.unauthorized().code).toBe('UNAUTHORIZED');
  });
});

describe('toAppError', () => {
  it('returns the same instance for an AppError', () => {
    const original = Errors.forbidden('no');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error as a non-exposed INTERNAL with the cause', () => {
    const e = new Error('kaboom');
    const wrapped = toAppError(e);
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.expose).toBe(false);
    expect(wrapped.message).toBe('kaboom');
    expect((wrapped as { cause?: unknown }).cause).toBe(e);
  });

  it('wraps a non-Error value as INTERNAL "Unknown error"', () => {
    const wrapped = toAppError('just a string');
    expect(wrapped.code).toBe('INTERNAL');
    expect(wrapped.message).toBe('Unknown error');
    expect((wrapped as { cause?: unknown }).cause).toBe('just a string');
  });
});
