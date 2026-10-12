import { describe, it, expect } from 'vitest';
import {
  allocateBatch,
  dueForNextBatch,
  isStranded,
  jitterDelay,
  orderClaims,
  senderReadiness,
  type SenderClaim,
} from '../../src/domain/campaignSchedule';

function claim(campaignId: string, extra: Partial<SenderClaim> = {}): SenderClaim {
  return { campaignId, campaignPriority: 5, createdAt: 1000, queued: 100, ...extra };
}

describe('orderClaims', () => {
  it('puts higher priority first', () => {
    const out = orderClaims([claim('low', { campaignPriority: 1 }), claim('high', { campaignPriority: 9 })]);
    expect(out.map((c) => c.campaignId)).toEqual(['high', 'low']);
  });

  it('breaks ties by oldest campaign', () => {
    const out = orderClaims([claim('new', { createdAt: 2000 }), claim('old', { createdAt: 1000 })]);
    expect(out.map((c) => c.campaignId)).toEqual(['old', 'new']);
  });

  it('is deterministic when everything ties', () => {
    const a = orderClaims([claim('b'), claim('a')]).map((c) => c.campaignId);
    const b = orderClaims([claim('a'), claim('b')]).map((c) => c.campaignId);
    expect(a).toEqual(['a', 'b']);
    expect(b).toEqual(a);
  });

  it('does not mutate the input', () => {
    const input = [claim('low', { campaignPriority: 1 }), claim('high', { campaignPriority: 9 })];
    orderClaims(input);
    expect(input[0].campaignId).toBe('low');
  });
});

describe('allocateBatch', () => {
  it('splits evenly when everyone has work', () => {
    const out = allocateBatch(10, [claim('a'), claim('b')]);
    expect(out).toEqual({ a: 5, b: 5 });
  });

  it('does not starve a lower-priority campaign', () => {
    const out = allocateBatch(10, [claim('big', { campaignPriority: 9, queued: 5000 }), claim('small', { campaignPriority: 1, queued: 5000 })]);
    expect(out.small).toBe(5);
    expect(out.big).toBe(5);
  });

  it('gives leftovers back down the priority order', () => {
    const out = allocateBatch(10, [claim('first', { campaignPriority: 9, queued: 2 }), claim('second', { campaignPriority: 5, queued: 100 })]);
    expect(out.first).toBe(2);
    expect(out.second).toBe(8);
  });

  it('never hands out more than a campaign has queued', () => {
    const out = allocateBatch(10, [claim('a', { queued: 1 }), claim('b', { queued: 1 })]);
    expect(out.a + out.b).toBe(2);
  });

  it('returns nothing for zero allowance or no claims', () => {
    expect(allocateBatch(0, [claim('a')])).toEqual({});
    expect(allocateBatch(10, [])).toEqual({});
  });
});

describe('senderReadiness', () => {
  const base = { enabled: true, inWindow: true, now: 1_000_000, capToday: 100, sentToday: 40, sentThisHour: 0 };

  it('is ready with the daily headroom', () => {
    expect(senderReadiness(base)).toEqual({ ready: true, allowance: 60 });
  });

  it('is bounded by the hourly cap', () => {
    expect(senderReadiness({ ...base, hourlyCap: 20, sentThisHour: 5 })).toEqual({ ready: true, allowance: 15 });
  });

  it('refuses a paused mailbox', () => {
    const r = senderReadiness({ ...base, enabled: false });
    expect(r.ready).toBe(false);
    expect(r.reason).toBe('paused');
  });

  it('refuses a cooling mailbox until the cooldown lapses', () => {
    expect(senderReadiness({ ...base, coolingUntil: base.now + 1 }).reason).toBe('cooling down');
    expect(senderReadiness({ ...base, coolingUntil: base.now - 1 }).ready).toBe(true);
  });

  it('refuses outside the send window', () => {
    expect(senderReadiness({ ...base, inWindow: false }).reason).toBe('outside send window');
  });

  it('reports which cap ran out', () => {
    expect(senderReadiness({ ...base, sentToday: 100 }).reason).toBe('daily cap reached');
    expect(senderReadiness({ ...base, hourlyCap: 10, sentThisHour: 10 }).reason).toBe('hourly cap reached');
  });
});

describe('dueForNextBatch', () => {
  it('is always due without a delay or a previous batch', () => {
    expect(dueForNextBatch(undefined, 5000, 9999)).toBe(true);
    expect(dueForNextBatch(1000, undefined, 9999)).toBe(true);
  });

  it('waits out the configured delay', () => {
    expect(dueForNextBatch(1000, 5000, 4000)).toBe(false);
    expect(dueForNextBatch(1000, 5000, 6000)).toBe(true);
  });
});

describe('jitterDelay', () => {
  it('is zero when there is no delay', () => {
    expect(jitterDelay(0)).toBe(0);
    expect(jitterDelay(undefined)).toBe(0);
  });

  it('adds up to 50% on top of the base delay', () => {
    expect(jitterDelay(1000, () => 0)).toBe(1000);
    expect(jitterDelay(1000, () => 1)).toBe(1500);
  });

  it('clamps the random input and the total', () => {
    expect(jitterDelay(1000, () => 5)).toBe(1500);
    expect(jitterDelay(60 * 60 * 1000, () => 1)).toBe(15 * 60 * 1000);
  });
});

describe('isStranded', () => {
  it('flags work stuck on a paused or cooling mailbox', () => {
    expect(isStranded({ enabled: false, cooling: false, queueLength: 5 })).toBe(true);
    expect(isStranded({ enabled: true, cooling: true, queueLength: 5 })).toBe(true);
  });

  it('leaves healthy mailboxes alone', () => {
    expect(isStranded({ enabled: true, cooling: false, queueLength: 5 })).toBe(false);
    expect(isStranded({ enabled: false, cooling: false, queueLength: 0 })).toBe(false);
  });
});
