import { describe, expect, it } from 'vitest';
import { created, errorResponse, json, noContent, ok } from '../../../src/http/responses';
import { AppError, Errors } from '../../../src/shared/errors';

describe('response helpers', () => {
  it('json sets status, JSON content-type, and serialised body', () => {
    const res = json(200, { a: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(res.body)).toEqual({ a: 1 });
  });

  it('json merges extra headers', () => {
    const res = json(200, {}, { 'x-trace': 'abc' });
    expect(res.headers).toMatchObject({ 'content-type': 'application/json', 'x-trace': 'abc' });
  });

  it('ok returns 200', () => {
    expect(ok({ ok: true }).statusCode).toBe(200);
  });

  it('created returns 201', () => {
    expect(created({ id: 'x' }).statusCode).toBe(201);
  });

  it('noContent returns 204 with an empty body and no content-type', () => {
    const res = noContent();
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers).toEqual({});
  });
});

describe('errorResponse', () => {
  it('maps an AppError to its status and the error envelope', () => {
    const res = errorResponse(Errors.notFound('nope'));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'NOT_FOUND', message: 'nope' } });
  });

  it('hides the message for a non-exposed error', () => {
    const res = errorResponse(new AppError('INTERNAL', 'stack leak', { expose: false }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.message).toBe('An unexpected error occurred.');
  });

  it('wraps an unknown thrown value as a 500 envelope', () => {
    const res = errorResponse(new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body).error.code).toBe('INTERNAL');
  });
});
