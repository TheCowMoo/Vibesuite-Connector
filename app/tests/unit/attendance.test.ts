import { describe, it, expect } from 'vitest';
import { buildReport, normalizeEmail } from '../../src/domain/attendance';

const base = { sessionId: 's1', provider: 'zoom' };

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
  });
});

describe('buildReport', () => {
  it('marks invited attendees as attended and the rest as no-show', () => {
    const r = buildReport({
      ...base,
      invitedEmails: ['a@x.com', 'b@x.com'],
      attendees: [{ email: 'a@x.com', durationSec: 300 }],
    });
    expect(r.attended.map((p) => p.email)).toEqual(['a@x.com']);
    expect(r.noShow).toEqual(['b@x.com']);
    expect(r.attendedCount).toBe(1);
    expect(r.noShowCount).toBe(1);
    expect(r.invitedCount).toBe(2);
  });

  it('matches email case-insensitively', () => {
    const r = buildReport({ ...base, invitedEmails: ['A@X.com'], attendees: [{ email: 'a@x.com', durationSec: 10 }] });
    expect(r.attended).toHaveLength(1);
    expect(r.noShow).toHaveLength(0);
  });

  it('treats uninvited attendees as attendedNotInvited', () => {
    const r = buildReport({
      ...base,
      invitedEmails: ['a@x.com'],
      attendees: [{ email: 'stranger@y.com', durationSec: 100 }],
    });
    expect(r.attendedNotInvited.map((p) => p.email)).toEqual(['stranger@y.com']);
  });

  it('applies the minimum-duration gate (partial)', () => {
    const r = buildReport({
      ...base,
      invitedEmails: ['a@x.com'],
      attendees: [{ email: 'a@x.com', durationSec: 30 }],
      minSeconds: 60,
    });
    expect(r.attended[0].status).toBe('partial');
  });

  it('merges duplicate joins by summing duration', () => {
    const r = buildReport({
      ...base,
      invitedEmails: ['a@x.com'],
      attendees: [
        { email: 'a@x.com', durationSec: 40 },
        { email: 'a@x.com', durationSec: 40 },
      ],
      minSeconds: 60,
    });
    expect(r.attended).toHaveLength(1);
    expect(r.attended[0].status).toBe('attended');
    expect(r.attended[0].durationSec).toBe(80);
  });

  it('places email-less attendees into attendedNotInvited', () => {
    const r = buildReport({
      ...base,
      invitedEmails: ['a@x.com'],
      attendees: [{ name: 'Anonymous', durationSec: 120 }],
    });
    expect(r.attendedNotInvited).toHaveLength(1);
    expect(r.attendedNotInvited[0].name).toBe('Anonymous');
  });

  it('computes attendanceRate and carries absentees / registrants / sessionStats / polls / qa', () => {
    const r = buildReport({
      ...base,
      sessionType: 'webinar',
      sessionTitle: 'Q3 Webinar',
      invitedEmails: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'],
      attendees: [
        { email: 'a@x.com', durationSec: 600 },
        { email: 'b@x.com', durationSec: 120 },
      ],
      absentees: ['c@x.com', 'd@x.com'],
      registrantCount: 4,
      sessionStats: { topic: 'Q3 Webinar', total_minutes: '120', participants_count: '2' },
      polls: [{ id: 'p1' }],
      qa: [{ question: 'Q?' }],
    });
    expect(r.attendanceRate).toBe(0.5);
    expect(r.registrantCount).toBe(4);
    expect(r.absentees).toEqual(['c@x.com', 'd@x.com']);
    expect(r.sessionStats.topic).toBe('Q3 Webinar');
    expect(r.polls).toHaveLength(1);
    expect(r.qa).toHaveLength(1);
    expect(r.sessionType).toBe('webinar');
  });

  it('carries per-attendee engagement stats', () => {
    const r = buildReport({
      ...base,
      invitedEmails: ['a@x.com'],
      attendees: [
        { email: 'a@x.com', durationSec: 300, attentivenessScore: 88, isGuest: false, registrantId: 'reg1', userId: 'u1' },
      ],
    });
    const p = r.attended[0];
    expect(p.attentivenessScore).toBe(88);
    expect(p.isGuest).toBe(false);
    expect(p.registrantId).toBe('reg1');
    expect(p.userId).toBe('u1');
  });

  it('reports a zero attendance rate with no invitees', () => {
    const r = buildReport({ ...base, invitedEmails: [], attendees: [{ email: 'a@x.com', durationSec: 60 }] });
    expect(r.attendanceRate).toBe(0);
    expect(r.attendedNotInvited).toHaveLength(1);
  });
});
