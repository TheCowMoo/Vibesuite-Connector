import { describe, it, expect } from 'vitest';
import {
  addDays,
  allocateEmails,
  computeAllocation,
  planSchedule,
  type CampaignSender,
} from '../../src/domain/campaign';
import type { SenderProfile } from '../../src/domain/senderLoad';

function sender(connectionId: string, extra: Partial<CampaignSender> = {}): CampaignSender {
  return { connectionId, enabled: true, priority: 5, ...extra };
}

describe('computeAllocation', () => {
  it('splits evenly', () => {
    expect(computeAllocation(4, [sender('a'), sender('b')])).toEqual({ a: 2, b: 2 });
  });

  it('hands the remainder to the first senders', () => {
    expect(computeAllocation(5, [sender('a'), sender('b')])).toEqual({ a: 3, b: 2 });
  });

  it('skips disabled senders entirely', () => {
    expect(computeAllocation(10, [sender('a'), sender('b', { enabled: false })])).toEqual({ a: 10 });
  });

  it('honours per-sender quotas and redistributes the overflow', () => {
    const alloc = computeAllocation(10, [sender('a', { quota: 2 }), sender('b')]);
    expect(alloc.a).toBe(2);
    expect(alloc.b).toBe(8);
    expect(alloc.a + alloc.b).toBe(10);
  });

  it('respects weighted shares', () => {
    expect(computeAllocation(4, [sender('a', { share: 3 }), sender('b', { share: 1 })])).toEqual({ a: 3, b: 1 });
  });

  it('returns nothing when there is nothing to send', () => {
    expect(computeAllocation(0, [sender('a')])).toEqual({});
    expect(computeAllocation(10, [sender('a', { enabled: false })])).toEqual({});
  });

  it('never allocates more than the total when every quota is tiny', () => {
    const alloc = computeAllocation(100, [sender('a', { quota: 1 }), sender('b', { quota: 1 })]);
    expect(alloc.a + alloc.b).toBe(2);
  });
});

describe('allocateEmails', () => {
  it('round-robins so each sender list is interleaved', () => {
    const out = allocateEmails(['a', 'b', 'c', 'd'], [sender('s1'), sender('s2')]);
    expect(out.s1).toEqual(['a', 'c']);
    expect(out.s2).toEqual(['b', 'd']);
  });

  it('loses and duplicates nothing', () => {
    const emails = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    const out = allocateEmails(emails, [sender('s1', { quota: 2 }), sender('s2')]);
    const flat = [...out.s1, ...out.s2].sort();
    expect(flat).toEqual([...emails].sort());
    expect(out.s1.length).toBe(2);
  });

  it('handles an empty audience', () => {
    expect(allocateEmails([], [sender('s1')])).toEqual({});
  });
});

describe('addDays', () => {
  it('advances whole days across month boundaries', () => {
    expect(addDays('2026-10-01', 3)).toBe('2026-10-04');
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
  });
});

describe('planSchedule', () => {
  function profile(over: Partial<SenderProfile> = {}): SenderProfile {
    return {
      connectionId: 's1',
      enabled: true,
      mode: 'flat',
      dailyCap: 40,
      window: { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5], timeZone: 'UTC' },
      ...over,
    };
  }

  it('walks a single sender day by day', () => {
    const plan = planSchedule({ total: 100, senders: [{ connectionId: 's1', profile: profile() }], startDate: '2026-10-01' });
    expect(plan.totalDays).toBe(3);
    expect(plan.days.map((d) => d.total)).toEqual([40, 40, 20]);
    expect(plan.finishDate).toBe('2026-10-03');
    expect(plan.days[2].cumulative).toBe(100);
  });

  it('adds mailboxes together', () => {
    const plan = planSchedule({
      total: 100,
      senders: [
        { connectionId: 's1', profile: profile() },
        { connectionId: 's2', profile: profile({ connectionId: 's2', dailyCap: 60 }) },
      ],
      startDate: '2026-10-01',
    });
    expect(plan.totalDays).toBe(1);
    expect(plan.days[0].perSender).toEqual({ s1: 40, s2: 60 });
  });

  it('grows a ramped mailbox over time', () => {
    const ramped = profile({
      mode: 'ramp',
      dailyCap: 100,
      ramp: { startDailyCap: 10, incrementPerDay: 10, maxDailyCap: 100, startDate: '2026-10-01' },
    });
    const plan = planSchedule({ total: 60, senders: [{ connectionId: 's1', profile: ramped }], startDate: '2026-10-01' });
    expect(plan.days.map((d) => d.total)).toEqual([10, 20, 30]);
  });

  it('ignores paused mailboxes', () => {
    const plan = planSchedule({
      total: 50,
      senders: [{ connectionId: 's1', profile: profile({ enabled: false }) }],
      startDate: '2026-10-01',
    });
    expect(plan.totalDays).toBe(0);
    expect(plan.finishDate).toBeNull();
  });

  it('respects maxDays', () => {
    const plan = planSchedule({ total: 10000, senders: [{ connectionId: 's1', profile: profile() }], startDate: '2026-10-01', maxDays: 2 });
    expect(plan.totalDays).toBe(2);
    expect(plan.days[1].cumulative).toBe(80);
  });
});
