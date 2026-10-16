import { describe, it, expect } from 'vitest';
import { planInviteSplit, type AccountAllowance } from '../../src/domain/invitePlan';

const acc = (id: string, allowance: number, reason?: string): AccountAllowance => ({ connectionId: id, allowance, reason });
const emails = (n: number, prefix = 'u') => Array.from({ length: n }, (_, i) => `${prefix}${i}@x.com`);

function placed(split: ReturnType<typeof planInviteSplit>): string[] {
  return Object.values(split.allocated).flat();
}

describe('planInviteSplit', () => {
  it('splits an audience evenly across accounts', () => {
    const split = planInviteSplit(emails(10), [acc('a', 100), acc('b', 100)]);
    expect(split.allocated.a).toHaveLength(5);
    expect(split.allocated.b).toHaveLength(5);
    expect(split.unplaced).toEqual([]);
  });

  it('never gives an account more than its allowance', () => {
    const split = planInviteSplit(emails(100), [acc('a', 10), acc('b', 10)]);
    expect(split.allocated.a).toHaveLength(10);
    expect(split.allocated.b).toHaveLength(10);
    expect(placed(split)).toHaveLength(20);
  });

  it('reports the leftover instead of over-sending it', () => {
    const split = planInviteSplit(emails(100), [acc('a', 10), acc('b', 10)]);
    expect(split.unplaced).toHaveLength(80);
    expect(split.totalCapacity).toBe(20);
  });

  it('hands surplus to the account that still has room', () => {
    const split = planInviteSplit(emails(30), [acc('a', 5), acc('b', 100)]);
    expect(split.allocated.a).toHaveLength(5);
    expect(split.allocated.b).toHaveLength(25);
    expect(split.unplaced).toEqual([]);
  });

  it('gives nothing to an account with no headroom', () => {
    const split = planInviteSplit(emails(10), [acc('a', 0, 'daily cap reached'), acc('b', 10)]);
    expect(split.allocated.a).toBeUndefined();
    expect(split.allocated.b).toHaveLength(10);
  });

  it('spreads across three accounts when one is unusable', () => {
    const split = planInviteSplit(emails(20), [acc('a', 0, 'paused'), acc('b', 100), acc('c', 100)]);
    expect(split.allocated.b).toHaveLength(10);
    expect(split.allocated.c).toHaveLength(10);
  });

  /*
   * The invariant that protects real people: nobody may appear in two mailboxes' slices, and placed
   * plus unplaced must account for every input email exactly once.
   */
  it('never assigns the same person twice, and accounts for everyone', () => {
    const list = emails(97);
    const split = planInviteSplit(list, [acc('a', 30), acc('b', 7), acc('c', 25)]);
    const all = placed(split);

    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(62);
    expect(all.length + split.unplaced.length).toBe(list.length);
    expect(new Set([...all, ...split.unplaced]).size).toBe(list.length);
  });

  it('interleaves rather than handing out contiguous blocks', () => {
    const split = planInviteSplit(emails(6), [acc('a', 100), acc('b', 100)]);
    expect(split.allocated.a).toEqual(['u0@x.com', 'u2@x.com', 'u4@x.com']);
    expect(split.allocated.b).toEqual(['u1@x.com', 'u3@x.com', 'u5@x.com']);
  });

  it('sends nothing at all when no account can send', () => {
    const split = planInviteSplit(emails(10), [acc('a', 0, 'paused'), acc('b', 0, 'outside send window')]);
    expect(split.allocated).toEqual({});
    expect(split.unplaced).toHaveLength(10);
    expect(split.totalCapacity).toBe(0);
  });

  it('is a no-op for an empty audience', () => {
    const split = planInviteSplit([], [acc('a', 100)]);
    expect(split.allocated).toEqual({});
    expect(split.unplaced).toEqual([]);
  });
});
