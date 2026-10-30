import { describe, it, expect } from 'vitest';
import { buildCampaignStats, normalizeRsvp, percent } from '../../src/domain/campaignStats';
import type { RecipientRecord } from '../../src/domain/campaign';

function rec(
  email: string,
  connectionId: string,
  status: RecipientRecord['status'],
  eventId?: string,
  variant?: RecipientRecord['variant'],
): RecipientRecord {
  return { email, connectionId, status, eventId, variant };
}

describe('normalizeRsvp', () => {
  it('passes through the three real answers', () => {
    expect(normalizeRsvp('accepted')).toBe('accepted');
    expect(normalizeRsvp('DECLINED')).toBe('declined');
    expect(normalizeRsvp('tentative')).toBe('tentative');
  });

  it('treats anything else as no response', () => {
    expect(normalizeRsvp('needsAction')).toBe('needsAction');
    expect(normalizeRsvp(undefined)).toBe('needsAction');
    expect(normalizeRsvp('garbage')).toBe('needsAction');
  });
});

describe('percent', () => {
  it('never divides by zero', () => {
    expect(percent(0, 0)).toBe(0);
  });

  it('rounds to one decimal', () => {
    expect(percent(1, 2)).toBe(50);
    expect(percent(1, 3)).toBe(33.3);
    expect(percent(2, 3)).toBe(66.7);
  });
});

describe('buildCampaignStats', () => {
  it('counts a funnel and attributes it per mailbox', () => {
    const { funnel, perSender, hasAttendance } = buildCampaignStats({
      recipients: [
        rec('a@x.com', 'm1', 'sent', 'ev1'),
        rec('b@x.com', 'm1', 'sent', 'ev1'),
        rec('c@x.com', 'm2', 'failed'),
        rec('d@x.com', 'm2', 'pending'),
      ],
      rsvpByConnection: { m1: { ev1: { 'a@x.com': 'accepted', 'b@x.com': 'declined' } } },
    });

    expect(funnel).toMatchObject({ invited: 4, sent: 2, failed: 1, queued: 1, accepted: 1, declined: 1, noResponse: 0 });
    expect(funnel.rsvpRate).toBe(100);
    expect(funnel.acceptanceRate).toBe(50);
    expect(hasAttendance).toBe(false);

    expect(perSender.map((p) => p.connectionId)).toEqual(['m1', 'm2']);
    expect(perSender[0]).toMatchObject({ sent: 2, accepted: 1, declined: 1 });
    expect(perSender[1]).toMatchObject({ invited: 2, sent: 0, failed: 1 });
  });

  it('treats a missing RSVP entry as no reply', () => {
    const { funnel } = buildCampaignStats({
      recipients: [rec('a@x.com', 'm1', 'sent', 'ev1'), rec('b@x.com', 'm1', 'sent', 'other-event')],
      rsvpByConnection: { m1: { ev1: { 'a@x.com': 'tentative' } } },
    });
    expect(funnel.tentative).toBe(1);
    expect(funnel.noResponse).toBe(1);
    expect(funnel.rsvpRate).toBe(50);
  });

  it('matches recipients and RSVP keys case-insensitively', () => {
    const { funnel } = buildCampaignStats({
      recipients: [rec('A@X.com', 'm1', 'sent', 'ev1')],
      rsvpByConnection: { m1: { ev1: { 'a@x.com': 'accepted' } } },
    });
    expect(funnel.accepted).toBe(1);
  });

  it('folds in session attendance when a report exists', () => {
    const { funnel, hasAttendance } = buildCampaignStats({
      recipients: [
        rec('a@x.com', 'm1', 'sent', 'ev1'),
        rec('b@x.com', 'm1', 'sent', 'ev1'),
        rec('c@x.com', 'm1', 'sent', 'ev1'),
        rec('d@x.com', 'm1', 'sent', 'ev1'),
      ],
      rsvpByConnection: {
        m1: { ev1: { 'a@x.com': 'accepted', 'b@x.com': 'accepted', 'c@x.com': 'tentative', 'd@x.com': 'declined' } },
      },
      attendanceByEmail: { 'a@x.com': true, 'b@x.com': false, 'c@x.com': false, 'd@x.com': false },
    });

    expect(hasAttendance).toBe(true);
    expect(funnel.accepted).toBe(2);
    expect(funnel.tentative).toBe(1);
    expect(funnel.attended).toBe(1);
    // b (accepted) and c (tentative) were both expected but never showed; d declined.
    expect(funnel.noShow).toBe(2);
    expect(funnel.attendanceRate).toBe(33.3);
  });

  it('attributes attendance back to the sending mailbox', () => {
    const { perSender } = buildCampaignStats({
      recipients: [rec('a@x.com', 'm1', 'sent', 'ev1'), rec('b@x.com', 'm2', 'sent', 'ev2')],
      rsvpByConnection: {
        m1: { ev1: { 'a@x.com': 'accepted' } },
        m2: { ev2: { 'b@x.com': 'accepted' } },
      },
      attendanceByEmail: { 'a@x.com': true, 'b@x.com': false },
    });

    const m1 = perSender.find((p) => p.connectionId === 'm1')!;
    const m2 = perSender.find((p) => p.connectionId === 'm2')!;
    expect(m1.attended).toBe(1);
    expect(m1.noShow).toBe(0);
    expect(m2.attended).toBe(0);
    expect(m2.noShow).toBe(1);
  });

  it('handles an empty campaign', () => {
    const { funnel, perSender, variants } = buildCampaignStats({ recipients: [], rsvpByConnection: {} });
    expect(funnel.invited).toBe(0);
    expect(funnel.acceptanceRate).toBe(0);
    expect(perSender).toEqual([]);
    expect(variants).toEqual([]);
  });

  it('attributes the funnel per copy variant', () => {
    const { funnel, variants } = buildCampaignStats({
      recipients: [
        rec('a@x.com', 'm1', 'sent', 'evA', 'A'),
        rec('b@x.com', 'm1', 'sent', 'evA', 'A'),
        rec('c@x.com', 'm1', 'sent', 'evB', 'B'),
      ],
      rsvpByConnection: {
        m1: { evA: { 'a@x.com': 'accepted', 'b@x.com': 'declined' }, evB: { 'c@x.com': 'accepted' } },
      },
    });

    expect(funnel).toMatchObject({ invited: 3, sent: 3, accepted: 2, declined: 1 });
    expect(variants.map((v) => v.variant)).toEqual(['A', 'B']);
    expect(variants[0]).toMatchObject({ variant: 'A', invited: 2, sent: 2, accepted: 1, declined: 1, acceptanceRate: 50 });
    expect(variants[1]).toMatchObject({ variant: 'B', invited: 1, sent: 1, accepted: 1, acceptanceRate: 100 });
  });
});
