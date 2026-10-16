import { describe, it, expect } from 'vitest';
import { reconcileConnections } from '../../src/domain/reconcile';

describe('reconcileConnections', () => {
  it('sweeps every connection it is given, in order', async () => {
    const seen: string[] = [];
    const out = await reconcileConnections(['a', 'b', 'c'], async (id) => {
      seen.push(id);
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(out).toEqual({ attempted: 3, failed: 0, failures: [] });
  });

  /*
   * The property that matters most. If one unreachable connection aborted the pass, a single bad
   * mailbox would silently stop reconciliation for every other connection — which is the exact
   * failure this whole sweep exists to prevent.
   */
  it('keeps going after a failure, and reports which connection failed', async () => {
    const seen: string[] = [];
    const out = await reconcileConnections(['a', 'b', 'c'], async (id) => {
      seen.push(id);
      if (id === 'b') throw new Error('GHL 502');
    });
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(out.attempted).toBe(3);
    expect(out.failed).toBe(1);
    expect(out.failures).toEqual([{ connectionId: 'b', message: 'GHL 502' }]);
  });

  it('records every failure, not just the first', async () => {
    const out = await reconcileConnections(['a', 'b'], async () => {
      throw new Error('nope');
    });
    expect(out.failed).toBe(2);
    expect(out.failures.map((f) => f.connectionId)).toEqual(['a', 'b']);
  });

  it('survives a thrown non-Error', async () => {
    const out = await reconcileConnections(['a'], async () => {
      throw 'plain string';
    });
    expect(out.failed).toBe(1);
    expect(out.failures[0].message).toBe('plain string');
  });

  it('is a no-op for an empty fleet', async () => {
    const out = await reconcileConnections([], async () => {
      throw new Error('should never run');
    });
    expect(out).toEqual({ attempted: 0, failed: 0, failures: [] });
  });
});
