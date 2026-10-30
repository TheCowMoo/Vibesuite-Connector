import { describe, it, expect } from 'vitest';
import { forEachLimit, withRetry } from '../../src/domain/concurrency';

const tick = (ms = 4) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('forEachLimit', () => {
  it('processes every item', async () => {
    const seen: number[] = [];
    await forEachLimit([1, 2, 3, 4, 5], 2, async (n) => {
      await tick(1);
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it('never exceeds the limit and actually runs work in parallel', async () => {
    let inFlight = 0;
    let peak = 0;
    await forEachLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(3);
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('treats a limit below one as one', async () => {
    let inFlight = 0;
    let peak = 0;
    await forEachLimit([1, 2, 3], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });

  it('resolves immediately for an empty list', async () => {
    await expect(
      forEachLimit([], 5, async () => {
        throw new Error('should not run');
      }),
    ).resolves.toBeUndefined();
  });

  it('propagates a failure', async () => {
    await expect(
      forEachLimit([1], 1, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

describe('withRetry', () => {
  it('returns on the first success without waiting', async () => {
    let calls = 0;
    const delays: number[] = [];
    const value = await withRetry(async () => {
      calls += 1;
      return 'ok';
    }, { sleep: async (ms) => { delays.push(ms); } });

    expect(value).toBe('ok');
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('retries with linear backoff and then succeeds', async () => {
    let calls = 0;
    const delays: number[] = [];
    const value = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    }, { attempts: 3, baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } });

    expect(value).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('rethrows the last error after the attempts are exhausted', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new Error('still failing');
    }, { attempts: 3, baseDelayMs: 0 })).rejects.toThrow('still failing');
    expect(calls).toBe(3);
  });

  it('does not retry when only one attempt is allowed', async () => {
    let calls = 0;
    await expect(withRetry(async () => {
      calls += 1;
      throw new Error('once');
    }, { attempts: 1 })).rejects.toThrow('once');
    expect(calls).toBe(1);
  });
});
