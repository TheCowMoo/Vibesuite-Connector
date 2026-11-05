import { describe, it, expect } from 'vitest';
import {
  buildCallsTable,
  buildCampaignSenderTable,
  buildCampaignTable,
  buildCampaignVariantTable,
  buildDailyTable,
  buildMailboxTable,
  buildSummaryTable,
  exportFilename,
  isOverviewScope,
  normalizeExportFormat,
  normalizeExportPeriod,
  normalizeExportScope,
  toCsv,
  toJsonRows,
  type CampaignExportRow,
} from '../../src/domain/statsExport';
import type { AttendanceReport } from '../../src/domain/attendance';
import type { Campaign } from '../../src/domain/campaign';
import type { CampaignFunnel, CampaignStats } from '../../src/domain/campaignStats';
import type { SessionRecord } from '../../src/domain/sessionStore';
import type { StatsOverview } from '../../src/domain/statsOverview';

function funnel(overrides: Partial<CampaignFunnel> = {}): CampaignFunnel {
  return {
    invited: 10,
    queued: 1,
    sent: 9,
    failed: 0,
    accepted: 4,
    declined: 1,
    tentative: 2,
    noResponse: 2,
    attended: 3,
    noShow: 1,
    rsvpRate: 77.8,
    acceptanceRate: 44.4,
    attendanceRate: 50,
    ...overrides,
  };
}

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: 'camp_1',
    name: 'Q3 webinar',
    status: 'active',
    listId: 'list_1',
    segments: [],
    event: {
      summary: 'Q3 webinar',
      start: '2026-10-01T10:00:00.000Z',
      end: '2026-10-01T11:00:00.000Z',
    },
    senders: [{ connectionId: 'conn_1', enabled: true, priority: 5 }],
    distribution: { mode: 'even' },
    includeAlreadyInvited: false,
    createdAt: Date.UTC(2026, 8, 1),
    ...overrides,
  } as Campaign;
}

function stats(overrides: Partial<CampaignStats> = {}): CampaignStats {
  return {
    funnel: funnel(),
    perSender: [
      {
        connectionId: 'conn_1',
        invited: 10,
        sent: 9,
        failed: 0,
        accepted: 4,
        declined: 1,
        tentative: 2,
        noResponse: 2,
        attended: 3,
        noShow: 1,
      },
    ],
    variants: [
      { variant: 'A', ...funnel() },
      { variant: 'B', ...funnel({ sent: 4, accepted: 1, rsvpRate: 50, acceptanceRate: 25 }) },
    ],
    hasAttendance: true,
    ...overrides,
  };
}

function campaignRow(overrides: Partial<Campaign> = {}, statsOverrides: Partial<CampaignStats> = {}): CampaignExportRow {
  return { campaign: campaign(overrides), stats: stats(statsOverrides) };
}

function overview(overrides: Partial<StatsOverview> = {}): StatsOverview {
  return {
    days: 30,
    hasActivity: true,
    totals: {
      campaigns: 2,
      activeCampaigns: 1,
      invitations: 9,
      pending: 3,
      failed: 1,
      sessions: 1,
      attendances: 5,
      noShows: 2,
      acceptanceRate: 44.4,
      attendanceRate: 71.4,
    },
    rsvp: { accepted: 4, declined: 1, tentative: 2, noResponse: 2 },
    daily: [
      { date: '2026-11-05', sent: 4 },
      { date: '2026-11-06', sent: 5 },
    ],
    byMailbox: [
      {
        connectionId: 'conn_1',
        invited: 10,
        sent: 9,
        failed: 0,
        accepted: 4,
        declined: 1,
        tentative: 2,
        noResponse: 2,
        attended: 3,
        noShow: 1,
      },
    ],
    topCampaigns: [],
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_1',
    provider: 'zoom',
    sessionType: 'webinar',
    externalId: '123456789',
    title: 'Q3 webinar',
    connectionId: 'conn_1',
    startTime: '2026-10-01T10:00:00.000Z',
    endTime: '2026-10-01T11:00:00.000Z',
    status: 'synced',
    lastSyncedAt: Date.UTC(2026, 9, 1, 12),
    rosterSentAt: Date.UTC(2026, 9, 1, 12, 5),
    lastDispatchedAt: Date.UTC(2026, 9, 1, 12, 6),
    createdAt: Date.UTC(2026, 8, 1),
    ...overrides,
  };
}

function report(overrides: Partial<AttendanceReport> = {}): AttendanceReport {
  return {
    sessionId: 'sess_1',
    provider: 'zoom',
    invitedSource: 'campaign',
    invitedCount: 4,
    attendedCount: 2,
    noShowCount: 1,
    attended: [
      { email: 'a@x.com', status: 'attended' },
      { email: 'b@x.com', status: 'partial' },
    ],
    noShow: ['c@x.com'],
    attendedNotInvited: [{ email: 'w@x.com', status: 'partial' }],
    absentees: [],
    registrantCount: 6,
    attendanceRate: 0.5,
    sessionStats: {},
    polls: [],
    qa: [],
    pollQuestionCount: 2,
    pollRespondentCount: 3,
    pollAnswerCount: 4,
    generatedAt: Date.UTC(2026, 9, 1, 12),
    ...overrides,
  };
}
describe('CSV writer', () => {
  it('writes labelled headers, a UTF-8 BOM and CRLF rows', () => {
    const csv = toCsv({
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'count', label: 'Count' },
      ],
      rows: [{ name: 'Ada', count: 2 }],
    });
    expect(csv).toBe('\uFEFFName,Count\r\nAda,2\r\n');
  });

  it('quotes commas, quotes and newlines, and leaves blanks empty', () => {
    const csv = toCsv({
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'note', label: 'Note' },
        { key: 'empty', label: 'Empty' },
      ],
      rows: [{ name: 'Ada, "Countess"', note: 'line 1\nline 2' }],
    });
    expect(csv).toContain('"Ada, ""Countess""","line 1\nline 2",\r\n');
  });

  it('keeps JSON rows keyed by column key, not label', () => {
    const rows = toJsonRows({
      columns: [{ key: 'invitations', label: 'Invitations sent' }],
      rows: [{ invitations: 9 }],
    });
    expect(rows).toEqual([{ invitations: 9 }]);
  });
});

describe('export parameters', () => {
  it('accepts only known scopes', () => {
    expect(normalizeExportScope('calls')).toBe('calls');
    expect(normalizeExportScope('campaign-senders')).toBe('campaign-senders');
    expect(normalizeExportScope('bogus')).toBeNull();
    expect(normalizeExportScope(undefined)).toBeNull();
  });

  it('defaults the format to CSV', () => {
    expect(normalizeExportFormat('json')).toBe('json');
    expect(normalizeExportFormat('csv')).toBe('csv');
    expect(normalizeExportFormat('JSON')).toBe('csv');
    expect(normalizeExportFormat(undefined)).toBe('csv');
  });

  it('clamps the period and treats all as no window', () => {
    expect(normalizeExportPeriod('all')).toBeNull();
    expect(normalizeExportPeriod('7')).toBe(7);
    expect(normalizeExportPeriod('9999')).toBe(365);
    expect(normalizeExportPeriod('0')).toBe(1);
    expect(normalizeExportPeriod('nope')).toBe(30);
    expect(normalizeExportPeriod(undefined)).toBe(30);
  });

  it('knows which scopes need a window', () => {
    expect(isOverviewScope('summary')).toBe(true);
    expect(isOverviewScope('daily')).toBe(true);
    expect(isOverviewScope('mailboxes')).toBe(true);
    expect(isOverviewScope('campaigns')).toBe(false);
    expect(isOverviewScope('calls')).toBe(false);
  });

  it('builds a safe filename', () => {
    expect(exportFilename('campaigns', 'csv', Date.UTC(2026, 10, 6))).toBe(
      'vibesuite-campaigns-2026-11-06.csv',
    );
    expect(exportFilename('calls', 'json', Date.UTC(2026, 10, 6), 'sess_1/../x')).toBe(
      'vibesuite-calls-sess1x-2026-11-06.json',
    );
  });
});

describe('overview tables', () => {
  it('exports the summary row', () => {
    const table = buildSummaryTable(overview());
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      periodDays: 30,
      invitations: 9,
      campaigns: 2,
      activeCampaigns: 1,
      pending: 3,
      failed: 1,
      sessions: 1,
      attendances: 5,
      noShows: 2,
      acceptanceRate: 44.4,
      attendanceRate: 71.4,
      rsvpAccepted: 4,
      rsvpDeclined: 1,
      rsvpTentative: 2,
      rsvpNoResponse: 2,
    });
  });

  it('exports one row per day', () => {
    expect(buildDailyTable(overview()).rows).toEqual([
      { date: '2026-11-05', invitations: 4 },
      { date: '2026-11-06', invitations: 5 },
    ]);
  });

  it('names sending accounts and leaves unknown names blank', () => {
    const named = buildMailboxTable(overview(), { conn_1: 'Ada' });
    expect(named.rows[0]).toMatchObject({ connection: 'Ada', connectionId: 'conn_1', sent: 9 });
    expect(buildMailboxTable(overview()).rows[0].connection).toBe('');
  });
});

describe('campaign tables', () => {
  it('exports the funnel, linked call and tracked attendance', () => {
    const table = buildCampaignTable([campaignRow({ sessionId: 'sess_1' })], { sess_1: 'Q3 live' });
    expect(table.rows[0]).toMatchObject({
      campaignId: 'camp_1',
      campaign: 'Q3 webinar',
      status: 'active',
      event: 'Q3 webinar',
      linkedCall: 'Q3 live',
      senders: 1,
      invited: 10,
      sent: 9,
      accepted: 4,
      attended: 3,
      noShow: 1,
      rsvpRate: 77.8,
      acceptanceRate: 44.4,
      attendanceRate: 50,
      attendanceTracked: 'yes',
    });
  });

  it('leaves attendance blank when the campaign has no attendance data', () => {
    const table = buildCampaignTable([campaignRow({}, { hasAttendance: false })]);
    expect(table.rows[0]).toMatchObject({
      attended: '',
      noShow: '',
      attendanceRate: '',
      attendanceTracked: 'no',
    });
  });

  it('exports one row per campaign and sending account', () => {
    const table = buildCampaignSenderTable([campaignRow()], { conn_1: 'Ada' });
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toMatchObject({
      campaign: 'Q3 webinar',
      connection: 'Ada',
      connectionId: 'conn_1',
      sent: 9,
      attended: 3,
    });
  });

  it('blanks sender attendance when the campaign has no attendance data', () => {
    const table = buildCampaignSenderTable([campaignRow({}, { hasAttendance: false })]);
    expect(table.rows[0]).toMatchObject({ attended: '', noShow: '' });
  });

  it('exports one row per copy variant', () => {
    const table = buildCampaignVariantTable([campaignRow()]);
    expect(table.rows.map((row) => row.variant)).toEqual(['A', 'B']);
    expect(table.rows[1]).toMatchObject({ sent: 4, acceptanceRate: 25 });
  });
});

describe('call table', () => {
  it('counts full attendance, brief visits, no-shows and walk-ins', () => {
    const table = buildCallsTable([{ session: session(), report: report() }], { conn_1: 'Ada' });
    expect(table.rows[0]).toMatchObject({
      callId: 'sess_1',
      call: 'Q3 webinar',
      type: 'webinar',
      provider: 'zoom',
      status: 'synced',
      lastSyncedAt: '2026-10-01T12:00:00.000Z',
      sendingAccount: 'Ada',
      connectionId: 'conn_1',
      invitedSource: 'campaign',
      invited: 4,
      attended: 1,
      briefVisits: 1,
      noShows: 1,
      walkIns: 1,
      attendanceRate: 50,
      pollQuestions: 2,
      pollRespondents: 3,
      pollAnswers: 4,
      qaEntries: 0,
      registrations: 6,
    });
  });

  it('leaves an unsynced call blank instead of inventing zeros', () => {
    const table = buildCallsTable([
      {
        session: session({ status: 'pending', error: 'HTTP 404', lastSyncedAt: undefined }),
        report: null,
      },
    ]);
    expect(table.rows[0]).toMatchObject({
      status: 'pending',
      lastSyncedAt: '',
      invited: '',
      attended: '',
      briefVisits: '',
      noShows: '',
      walkIns: '',
      attendanceRate: '',
      pollQuestions: '',
      syncError: 'HTTP 404',
    });
  });

  it('exports one row per call', () => {
    const table = buildCallsTable([
      { session: session(), report: report() },
      { session: session({ id: 'sess_2', title: 'Q4 webinar' }), report: null },
    ]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1].call).toBe('Q4 webinar');
  });
});

