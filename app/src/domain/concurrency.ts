/**
 * Run `fn` for every item with at most `limit` invocations in flight.
 *
 * Order is not preserved: callers that need a specific order must sort their results afterwards.
 * A thrown `fn` rejects the whole call; callers that expect partial failures should catch inside.
 */
export async function forEachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;

  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: size }, worker));
}

export interface RetryOptions {
  attempts?: number;
  /** Linear backoff: the delay before attempt N is `baseDelayMs * (N - 1)`. */
  baseDelayMs?: number;
  /** Injected by tests so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry a failing async step a bounded number of times, then rethrow the last error. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 400);
  const sleep = options.sleep ?? realSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < attempts && baseDelayMs > 0) await sleep(baseDelayMs * attempt);
    }
  }

  throw lastError;
}
