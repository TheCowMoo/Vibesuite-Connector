import { describe, it, expect } from 'vitest';
import {
  allocateBatch,
  blockedSendReasons,
  dueForNextBatch,
  isStranded,
  jitterDelay,
  orderClaims,
  senderCanProgress,
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
  const base = { enabled: true, inWindow: true, now: 1_000_000, capToday: 100, sentToday: 40 };

  it('is ready with the daily headroom', () => {
    expect(senderReadiness(base)).toEqual({ ready: true, allowance: 60 });
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

  it('reports the daily cap when it runs out', () => {
    expect(senderReadiness({ ...base, sentToday: 100 }).reason).toBe('daily cap reached');
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

  it('treats a paused Sending accounts profile as stranded', () => {
    expect(senderCanProgress({ enabled: true, profileEnabled: false, cooling: false })).toBe(false);
    expect(isStranded({ enabled: true, profileEnabled: false, cooling: false, queueLength: 5 })).toBe(true);
  });
});

describe('blockedSendReasons', () => {
  it('returns only the senders that sent and failed nothing, with their reason', () => {
    expect(blockedSendReasons([
      { connectionId: 'a', sent: 0, failed: 0, reason: 'paused' },
      { connectionId: 'b', sent: 2, failed: 0 },
      { connectionId: 'c', sent: 0, failed: 0, reason: 'daily cap reached' },
      { connectionId: 'd', sent: 0, failed: 1, reason: 'provider error' },
    ])).toEqual([
      { connectionId: 'a', reason: 'paused' },
      { connectionId: 'c', reason: 'daily cap reached' },
    ]);
  });

  it('returns nothing when a sender made progress', () => {
    expect(blockedSendReasons([{ connectionId: 'a', sent: 1, failed: 0, reason: 'unused' }])).toEqual([]);
  });
});

describe('senderReadiness with ignoreWindow', () => {
  const outside = { enabled: true, inWindow: false, now: 1_000_000, capToday: 100, sentToday: 40, sentThisHour: 0 };

  it('refuses a mailbox outside its send window by default', () => {
    expect(senderReadiness(outside)).toEqual({ ready: false, allowance: 0, reason: 'outside send window' });
  });

  /*
   * The one-off invitation path passes ignoreWindow: a manual send is an explicit act, not scheduled
   * pacing. That first assertion is the behaviour change; the rest are the guardrail proving nothing
   * else relaxed with it.
   */
  it('lets a manual send through outside the window', () => {
    expect(senderReadiness({ ...outside, ignoreWindow: true })).toEqual({ ready: true, allowance: 60 });
  });

  it('still enforces the daily cap, cooldowns and pause when the window is ignored', () => {
    expect(senderReadiness({ ...outside, ignoreWindow: true, sentToday: 100 })).toEqual({
      ready: false,
      allowance: 0,
      reason: 'daily cap reached',
    });
    expect(senderReadiness({ ...outside, ignoreWindow: true, coolingUntil: 2_000_000 })).toEqual({
      ready: false,
      allowance: 0,
      reason: 'cooling down',
    });
    expect(senderReadiness({ ...outside, ignoreWindow: true, enabled: false })).toEqual({
      ready: false,
      allowance: 0,
      reason: 'paused',
    });
  });
});
