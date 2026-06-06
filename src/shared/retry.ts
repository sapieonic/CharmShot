/**
 * Generic retry-with-exponential-backoff helper used for outbound model calls.
 *
 * An error is considered retryable unless it explicitly sets `retryable: false`.
 * Callers (e.g. providers) tag non-retryable errors so we don't waste attempts
 * on deterministic 4xx failures.
 */

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

function isRetryable(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'retryable' in err) {
    return (err as { retryable?: boolean }).retryable !== false;
  }
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const maxDelay = opts.maxDelayMs ?? 10_000;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= opts.maxAttempts || !isRetryable(err)) break;
      opts.onRetry?.(attempt, err);
      const backoff = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), maxDelay);
      // Full jitter to avoid thundering herds.
      const delay = Math.random() * backoff;
      await sleep(delay);
    }
  }
  throw lastErr;
}
