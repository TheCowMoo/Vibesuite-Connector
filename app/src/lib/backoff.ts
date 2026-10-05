export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  shouldRetryOn?: (error: unknown) => boolean;
  getRetryDelayMs?: (error: unknown, attempt: number) => number | undefined;
}

export function isRetryableError(err: unknown): boolean {
  const e = err as { response?: { status?: number } } | null;
  if (!e) return false;
  const status = e.response?.status;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30000;
  const jitter = opts.jitter ?? true;
  const retryOn = opts.shouldRetryOn ?? isRetryableError;
  const getDelay = opts.getRetryDelayMs;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !retryOn(err)) throw err;
      let delay = getDelay?.(err, attempt) ?? Math.min(max, base * Math.pow(2, attempt));
      if (jitter) delay = Math.round(delay * (1 + Math.random() * 0.25));
      await sleep(delay);
      attempt += 1;
    }
  }
}

