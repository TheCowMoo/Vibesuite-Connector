import { describe, expect, it } from 'vitest';
import type { AttendancePerson, AttendanceReport } from '../../src/domain/attendance';
import type { Campaign, RecipientRecord } from '../../src/domain/campaign';
import {
  buildCampaignCrm,
  campaignCrmWarnings,
  filterCampaignCrmRows,
  profilesFromList,
  selectCampaignCrmRows,
} from '../../src/domain/campaignCrm';
import type { ZoomBehavior } from '../../src/domain/zoomBehavior';

const behavior = {
  pollAnswers: [],
  qa: [],
  registrationAnswers: [],
  pollQuestions: [],
  pollQuestionCount: 0,
  pollAnsweredCount: 0,
  qaAskedCount: 0,
  qaAnsweredCount: 0,
  registrationAnswerCount: 0,
  pollAnswerText: '',
  qaQuestionText: '',
  registrationAnswerText: '',
} as ZoomBehavior;

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp1',
    name: 'November webinar',
    status: 'active',
    listId: 'l1',
    segments: [],
    event: { summary: 'Webinar', start: '2026-11-01T10:00:00Z', end: '2026-11-01T11:00:00Z', timeZone: 'UTC' },
    senders: [{ connectionId: 'c1', enabled: true, priority: 5 }],
    distribution: { mode: 'even' },
    includeAlreadyInvited: false,
    createdAt: 1,
    ...overrides,
  };
}

function rec(email: string, overrides: Partial<RecipientRecord> = {}): RecipientRecord {
  return { email, connectionId: 'c1', status: 'sent', eventId: 'e1', variant: 'A', sentAt: 100, ...overrides };
}

function attendee(email: string | undefined, name: string | undefined, status: 'attended' | 'partial' = 'attended'): AttendancePerson {
  return { email, name, status, durationSec: 600, joinedAt: '2026-11-01T10:05:00Z', behavior };
}

function report(overrides: Partial<AttendanceReport> = {}): AttendanceReport {
  return {
    sessionId: 's1',
    provider: 'zoom',
    invitedCount: 0,
    attendedCount: 0,
    noShowCount: 0,
    attended: [],
    noShow: [],
    attendedNotInvited: [],
    absentees: [],
    registrantCount: 0,
    attendanceRate: 0,
    sessionStats: {},
    polls: [],
    qa: [],
    pollQuestionCount: 0,
    pollRespondentCount: 0,
    pollAnswerCount: 0,
    generatedAt: 200,
    ...overrides,
  };
}

function build(overrides: {
  campaign?: Partial<Campaign>;
  recipients?: RecipientRecord[];
  rsvp?: Record<string, Record<string, Record<string, string>>>;
  attendance?: AttendanceReport | null;
  profiles?: Record<string, { name?: string; company?: string; phone?: string }>;
  notes?: Record<string, { followUp: 'none' | 'todo' | 'contacted' | 'done'; note: string; updatedAt?: number; updatedBy?: string }>;
  history?: Record<string, Record<string, Array<{ status: 'accepted' | 'declined' | 'tentative' | 'needsAction'; at: number; initial?: boolean }>>>;
}) {
  return buildCampaignCrm({
    campaign: campaign(overrides.campaign),
    recipients: overrides.recipients ?? [rec('ada@example.com')],
    rsvpByConnection: overrides.rsvp ?? {},
    attendance: overrides.attendance ?? null,
    profiles: overrides.profiles,
    notes: overrides.notes,
    history: overrides.history,
    connectionNames: { c1: 'Ada sender' },
  });
}

describe('buildCampaignCrm', () => {
  it('merges campaign, RSVP, Zoom behavior and history by normalized email', () => {
    const out = build({
      recipients: [rec('Ada@Example.com')],
      rsvp: { c1: { e1: { 'ada@example.com': 'accepted' } } },
      attendance: report({ attended: [attendee('ADA@example.com', 'Ada Lovelace')] }),
      history: { 'c1|e1': { 'ada@example.com': [{ status: 'accepted', at: 150, initial: true }] } },
    });
    expect(out.rows[0]).toMatchObject({
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      rsvp: 'accepted',
      zoom: 'attended',
      senderName: 'Ada sender',
      variant: 'A',
      sendStatus: 'sent',
    });
    expect(out.rows[0].behavior).toBe(behavior);
    expect(out.rows[0].rsvpHistory).toEqual([{ status: 'accepted', at: 150, initial: true }]);
    expect(out.summary).toMatchObject({ people: 1, sent: 1, rsvp: { accepted: 1 } });
  });

  it('separates a declined no-show from a yes-but-did-not-join', () => {
    const out = build({
      recipients: [rec('no@example.com'), rec('yes@example.com')],
      rsvp: { c1: { e1: { 'no@example.com': 'declined', 'yes@example.com': 'accepted' } } },
      attendance: report({ noShow: ['no@example.com', 'yes@example.com'] }),
    });
    expect(out.rows.map((row) => row.zoom)).toEqual(['didnt_join', 'didnt_join']);
    expect(out.summary.rsvp.declined).toBe(1);
    expect(out.summary.rsvp.accepted).toBe(1);
    expect(out.summary.yesButDidntJoin).toBe(1);
  });

  it('does not turn pending or failed recipients into no-shows', () => {
    const out = build({
      recipients: [
        rec('pending@example.com', { status: 'pending' }),
        rec('failed@example.com', { status: 'failed' }),
      ],
      attendance: report({ noShow: ['pending@example.com', 'failed@example.com'] }),
    });
    expect(out.rows.map((row) => row.zoom)).toEqual(['not_invited', 'not_invited']);
    expect(out.rows.map((row) => row.rsvp)).toEqual(['none', 'none']);
    expect(out.summary.pending).toBe(1);
    expect(out.summary.failed).toBe(1);
    expect(out.summary.zoom.notInvited).toBe(2);
  });

  it('adds walk-ins separately, including one without an email', () => {
    const out = build({
      campaign: { sessionId: 's1' },
      recipients: [rec('ada@example.com')],
      attendance: report({
        attended: [attendee('ada@example.com', 'Ada')],
        attendedNotInvited: [attendee('walkin@example.com', 'Walk In'), attendee(undefined, 'No Email')],
      }),
    });
    const walkIns = out.rows.filter((row) => row.walkIn);
    expect(walkIns).toHaveLength(2);
    expect(walkIns.map((row) => row.zoom)).toEqual(['walk_in', 'walk_in']);
    expect(out.summary.zoom.walkIns).toBe(2);
    expect(out.warnings.join(' ')).toContain('no email address');
  });

  it('prefers the Zoom name over the list profile for attendees', () => {
    const out = build({
      recipients: [rec('ada@example.com')],
      attendance: report({ attended: [attendee('ada@example.com', 'Ada Zoom')] }),
      profiles: { 'ada@example.com': { name: 'Ada List', company: 'Analytical Engines' } },
    });
    expect(out.rows[0].name).toBe('Ada Zoom');
    expect(out.rows[0].company).toBe('Analytical Engines');
  });

  it('warns when no call is linked, has no report, or is stale', () => {
    expect(build({ campaign: { sessionId: undefined } }).warnings.join(' ')).toContain('No call is linked');
    expect(build({ campaign: { sessionId: 's1' } }).warnings.join(' ')).toContain('no Zoom report');

    const stale = build({
      campaign: { sessionId: 's1' },
      recipients: [rec('ada@example.com', { sentAt: 500 })],
      attendance: report({ generatedAt: 100, attended: [attendee('ada@example.com', 'Ada')] }),
    });
    expect(stale.warnings.join(' ')).toContain('before the latest invitations');
  });

  it('reports a report that covers fewer people than were invited', () => {
    const out = build({
      campaign: { sessionId: 's1' },
      recipients: [rec('ada@example.com'), rec('grace@example.com')],
      attendance: report({ generatedAt: 500, attended: [attendee('ada@example.com', 'Ada')] }),
    });
    expect(out.warnings.join(' ')).toContain('covers 1 of 2');
  });

  it('counts follow-up notes in the summary, including walk-ins', () => {
    const out = build({
      recipients: [rec('ada@example.com')],
      notes: { 'ada@example.com': { followUp: 'todo', note: 'Call her' } },
      attendance: report({
        attended: [attendee('ada@example.com', 'Ada')],
        attendedNotInvited: [attendee('walk@example.com', 'Walk')],
      }),
    });
    expect(out.summary.followUp).toMatchObject({ none: 1, todo: 1, open: 1 });
  });
});

describe('profilesFromList', () => {
  it('extracts names, companies and phones from object rows and named strings', () => {
    const profiles = profilesFromList({
      segments: [
        {
          name: 'Hot',
          rows: [
            { email: 'Ada@Example.com', name: 'Ada Lovelace', company: 'Analytical Engines', phone: '123' },
            { 'e-mail': 'grace@example.com', 'first name': 'Grace', 'last name': 'Hopper' },
            'Katherine Johnson <katherine@example.com>',
          ],
        },
        { name: 'Cold', rows: [{ email: 'cold@example.com', full_name: 'Cold Person' }] },
      ],
    });

    expect(profiles['ada@example.com']).toEqual({ name: 'Ada Lovelace', company: 'Analytical Engines', phone: '123' });
    expect(profiles['grace@example.com']).toMatchObject({ name: 'Grace Hopper' });
    expect(profiles['katherine@example.com']).toMatchObject({ name: 'Katherine Johnson' });
    expect(profiles['cold@example.com']).toMatchObject({ name: 'Cold Person' });
  });

  it('honours the selected segments', () => {
    const profiles = profilesFromList(
      {
        segments: [
          { name: 'Hot', rows: [{ email: 'hot@example.com', name: 'Hot' }] },
          { name: 'Cold', rows: [{ email: 'cold@example.com', name: 'Cold' }] },
        ],
      },
      ['Hot'],
    );
    expect(profiles['hot@example.com']).toBeDefined();
    expect(profiles['cold@example.com']).toBeUndefined();
  });
});

describe('CRM filters and pagination', () => {
  const rows = build({
    recipients: [rec('ada@example.com'), rec('grace@example.com'), rec('lin@example.com')],
    rsvp: {
      c1: {
        e1: {
          'ada@example.com': 'accepted',
          'grace@example.com': 'declined',
          'lin@example.com': 'tentative',
        },
      },
    },
    attendance: report({ noShow: ['grace@example.com', 'lin@example.com'] }),
    profiles: { 'ada@example.com': { name: 'Ada', company: 'Analytical' } },
  }).rows;

  it('searches name, email and company', () => {
    expect(filterCampaignCrmRows(rows, { q: 'analytical' })).toHaveLength(1);
    expect(filterCampaignCrmRows(rows, { q: 'grace@' })).toHaveLength(1);
  });

  it('filters RSVP, Zoom, send, sender, variant and follow-up', () => {
    expect(filterCampaignCrmRows(rows, { rsvp: 'accepted' })).toHaveLength(1);
    expect(filterCampaignCrmRows(rows, { rsvp: 'no_reply' })).toHaveLength(0);
    expect(filterCampaignCrmRows(rows, { zoom: 'didnt_join' })).toHaveLength(2);
    expect(filterCampaignCrmRows(rows, { send: 'sent' })).toHaveLength(3);
    expect(filterCampaignCrmRows(rows, { sender: 'c1' })).toHaveLength(3);
    expect(filterCampaignCrmRows(rows, { variant: 'A' })).toHaveLength(3);
  });

  it('paginates and reports the filtered total', () => {
    const page = selectCampaignCrmRows(rows, { limit: 2, offset: 0, sort: 'rsvp' });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(3);
    expect(page.limit).toBe(2);
    expect(page.rows[0].rsvp).toBe('accepted');
  });

  it('warns about walk-ins and unmatched invited people directly', () => {
    const warnings = campaignCrmWarnings({
      sessionLinked: true,
      hasAttendance: true,
      attendanceGeneratedAt: 100,
      lastSentAt: 200,
      sentCount: 3,
      matchedCount: 1,
      noEmailWalkIns: 1,
      walkInCount: 2,
    });
    expect(warnings.join(' ')).toContain('before the latest invitations');
    expect(warnings.join(' ')).toContain('covers 1 of 3');
    expect(warnings.join(' ')).toContain('no email address');
    expect(warnings.join(' ')).toContain('2 walk-ins joined');
  });
});
