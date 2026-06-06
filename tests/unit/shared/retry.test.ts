import { describe, expect, it, vi } from 'vitest';
import { withRetry } from '../../../src/shared/retry';

describe('withRetry', () => {
  it('returns immediately on first success (no retry)', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, onRetry });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('retries then succeeds, invoking onRetry once before the successful attempt', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
      return 'recovered';
    });
    const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, onRetry });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('stops at maxAttempts and throws the last error', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      throw new Error('always');
    });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, onRetry })).rejects.toThrow('always');
    expect(fn).toHaveBeenCalledTimes(3);
    // onRetry fires between attempts only -> maxAttempts - 1 times.
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the error is marked retryable:false', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn(async () => {
      const err = Object.assign(new Error('client error'), { retryable: false });
      throw err;
    });
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 1, onRetry })).rejects.toThrow('client error');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('treats errors without a retryable flag as retryable', async () => {
    const fn = vi.fn(async () => {
      throw Object.assign(new Error('e'), { retryable: true });
    });
    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1 })).rejects.toThrow('e');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
