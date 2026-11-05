import type { AttendanceReport } from './attendance';
import type { Campaign } from './campaign';
import type { CampaignStats } from './campaignStats';
import type { SessionRecord } from './sessionStore';
import type { StatsOverview } from './statsOverview';

export const EXPORT_SCOPES = [
  'summary',
  'daily',
  'campaigns',
  'campaign-senders',
  'campaign-variants',
  'calls',
  'mailboxes',
] as const;

export type ExportScope = (typeof EXPORT_SCOPES)[number];
export type ExportFormat = 'csv' | 'json';

/**
 * Overview tables are windows by definition (a daily series needs a length). `period=all` is
 * clamped to the API ceiling for these scopes instead of pretending to be lifetime totals.
 */
export const OVERVIEW_EXPORT_SCOPES: readonly ExportScope[] = ['summary', 'daily', 'mailboxes'];

export interface ExportColumn {
  key: string;
  label: string;
}

/** Every CSV cell is rendered as text; numbers stay numbers in the JSON form. */
export type ExportCell = string | number;

export interface ExportRow {
  [key: string]: ExportCell;
}

export interface ExportTable {
  columns: ExportColumn[];
  rows: ExportRow[];
}

export function normalizeExportScope(value: unknown): ExportScope | null {
  return typeof value === 'string' && (EXPORT_SCOPES as readonly string[]).includes(value)
    ? (value as ExportScope)
    : null;
}

export function normalizeExportFormat(value: unknown): ExportFormat {
  return value === 'json' ? 'json' : 'csv';
}

/** `all` means no window; everything else is a 1–365 day window, defaulting to 30. */
export function normalizeExportPeriod(value: unknown): number | null {
  if (value === 'all') return null;
  const parsed = Number(value ?? 30);
  return Number.isFinite(parsed) ? Math.min(365, Math.max(1, Math.floor(parsed))) : 30;
}

export function isOverviewScope(scope: ExportScope): boolean {
  return OVERVIEW_EXPORT_SCOPES.includes(scope);
}

/** RFC 4180 CSV with a UTF-8 BOM and CRLF rows, so Excel opens it without an import dialog. */
export function toCsv(table: ExportTable): string {
  const lines = [table.columns.map((column) => csvCell(column.label)).join(',')];
  for (const row of table.rows) {
    lines.push(table.columns.map((column) => csvCell(row[column.key])).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function csvCell(value: ExportCell | undefined): string {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export function toJsonRows(table: ExportTable): Array<Record<string, ExportCell>> {
  return table.rows.map((row) => {
    const out: Record<string, ExportCell> = {};
    for (const column of table.columns) out[column.key] = row[column.key] ?? '';
    return out;
  });
}

export function exportFilename(
  scope: ExportScope,
  format: ExportFormat,
  now = Date.now(),
  suffix?: string,
): string {
  const date = new Date(now).toISOString().slice(0, 10);
  const clean = (suffix ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
  return `vibesuite-${scope}${clean ? `-${clean}` : ''}-${date}.${format}`;
}

function iso(ts?: number): string {
  return ts ? new Date(ts).toISOString() : '';
}

/** Calendar funnel rates are already 0–100 with one decimal. */
function fractionToPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}

export function buildSummaryTable(overview: StatsOverview): ExportTable {
  const totals = overview.totals;
  const rsvp = overview.rsvp;
  return {
    columns: [
      { key: 'periodDays', label: 'Period (days)' },
      { key: 'invitations', label: 'Invitations sent' },
      { key: 'campaigns', label: 'Campaigns in period' },
      { key: 'activeCampaigns', label: 'Active campaigns' },
      { key: 'pending', label: 'Still waiting' },
      { key: 'failed', label: 'Failed to send' },
      { key: 'sessions', label: 'Sessions' },
      { key: 'attendances', label: 'Attendances' },
      { key: 'noShows', label: 'No-shows' },
      { key: 'acceptanceRate', label: 'Acceptance rate (%)' },
      { key: 'attendanceRate', label: 'Attendance rate (%)' },
      { key: 'rsvpAccepted', label: 'Accepted' },
      { key: 'rsvpDeclined', label: 'Declined' },
      { key: 'rsvpTentative', label: 'Maybe' },
      { key: 'rsvpNoResponse', label: 'No reply' },
    ],
    rows: [
      {
        periodDays: overview.days,
        invitations: totals.invitations,
        campaigns: totals.campaigns,
        activeCampaigns: totals.activeCampaigns,
        pending: totals.pending,
        failed: totals.failed,
        sessions: totals.sessions,
        attendances: totals.attendances,
        noShows: totals.noShows,
        acceptanceRate: totals.acceptanceRate,
        attendanceRate: totals.attendanceRate,
        rsvpAccepted: rsvp.accepted,
        rsvpDeclined: rsvp.declined,
        rsvpTentative: rsvp.tentative,
        rsvpNoResponse: rsvp.noResponse,
      },
    ],
  };
}

export function buildDailyTable(overview: StatsOverview): ExportTable {
  return {
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'invitations', label: 'Invitations sent' },
    ],
    rows: overview.daily.map((day) => ({ date: day.date, invitations: day.sent })),
  };
}

export function buildMailboxTable(
  overview: StatsOverview,
  connectionNames: Record<string, string> = {},
): ExportTable {
  return {
    columns: [
      { key: 'connection', label: 'Sending account' },
      { key: 'connectionId', label: 'Connection id' },
      { key: 'invited', label: 'Invited' },
      { key: 'sent', label: 'Sent' },
      { key: 'failed', label: 'Failed' },
      { key: 'accepted', label: 'Accepted' },
      { key: 'declined', label: 'Declined' },
      { key: 'tentative', label: 'Maybe' },
      { key: 'noResponse', label: 'No reply' },
      { key: 'attended', label: 'Attended' },
      { key: 'noShow', label: 'No-show' },
    ],
    rows: overview.byMailbox.map((sender) => ({
      connection: connectionNames[sender.connectionId] ?? '',
      connectionId: sender.connectionId,
      invited: sender.invited,
      sent: sender.sent,
      failed: sender.failed,
      accepted: sender.accepted,
      declined: sender.declined,
      tentative: sender.tentative,
      noResponse: sender.noResponse,
      attended: sender.attended,
      noShow: sender.noShow,
    })),
  };
}
export interface CampaignExportRow {
  campaign: Campaign;
  stats: CampaignStats;
}

export interface CallExportRow {
  session: SessionRecord;
  report: AttendanceReport | null;
}

export function buildCampaignTable(
  rows: CampaignExportRow[],
  callTitles: Record<string, string> = {},
): ExportTable {
  return {
    columns: [
      { key: 'campaignId', label: 'Campaign id' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'status', label: 'Status' },
      { key: 'event', label: 'Event' },
      { key: 'listId', label: 'List id' },
      { key: 'linkedCall', label: 'Linked call' },
      { key: 'senders', label: 'Sending accounts' },
      { key: 'createdAt', label: 'Created' },
      { key: 'startedAt', label: 'Started' },
      { key: 'completedAt', label: 'Completed' },
      { key: 'invited', label: 'Invited' },
      { key: 'queued', label: 'Queued' },
      { key: 'sent', label: 'Sent' },
      { key: 'failed', label: 'Failed' },
      { key: 'accepted', label: 'Accepted' },
      { key: 'declined', label: 'Declined' },
      { key: 'tentative', label: 'Maybe' },
      { key: 'noResponse', label: 'No reply' },
      { key: 'attended', label: 'Attended' },
      { key: 'noShow', label: 'No-show' },
      { key: 'rsvpRate', label: 'RSVP rate (%)' },
      { key: 'acceptanceRate', label: 'Acceptance rate (%)' },
      { key: 'attendanceRate', label: 'Attendance rate (%)' },
      { key: 'attendanceTracked', label: 'Attendance tracked' },
    ],
    rows: rows.map(({ campaign, stats }) => {
      const funnel = stats.funnel;
      const tracked = stats.hasAttendance;
      return {
        campaignId: campaign.id,
        campaign: campaign.name,
        status: campaign.status,
        event: campaign.event?.summary ?? '',
        listId: campaign.listId,
        linkedCall: campaign.sessionId ? (callTitles[campaign.sessionId] ?? campaign.sessionId) : '',
        senders: campaign.senders.length,
        createdAt: iso(campaign.createdAt),
        startedAt: iso(campaign.startedAt),
        completedAt: iso(campaign.completedAt),
        invited: funnel.invited,
        queued: funnel.queued,
        sent: funnel.sent,
        failed: funnel.failed,
        accepted: funnel.accepted,
        declined: funnel.declined,
        tentative: funnel.tentative,
        noResponse: funnel.noResponse,
        attended: tracked ? funnel.attended : '',
        noShow: tracked ? funnel.noShow : '',
        rsvpRate: funnel.rsvpRate,
        acceptanceRate: funnel.acceptanceRate,
        attendanceRate: tracked ? funnel.attendanceRate : '',
        attendanceTracked: tracked ? 'yes' : 'no',
      };
    }),
  };
}

export function buildCampaignSenderTable(
  rows: CampaignExportRow[],
  connectionNames: Record<string, string> = {},
): ExportTable {
  const out: ExportRow[] = [];
  for (const { campaign, stats } of rows) {
    const tracked = stats.hasAttendance;
    for (const sender of stats.perSender) {
      out.push({
        campaignId: campaign.id,
        campaign: campaign.name,
        connection: connectionNames[sender.connectionId] ?? '',
        connectionId: sender.connectionId,
        invited: sender.invited,
        sent: sender.sent,
        failed: sender.failed,
        accepted: sender.accepted,
        declined: sender.declined,
        tentative: sender.tentative,
        noResponse: sender.noResponse,
        attended: tracked ? sender.attended : '',
        noShow: tracked ? sender.noShow : '',
      });
    }
  }
  return {
    columns: [
      { key: 'campaignId', label: 'Campaign id' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'connection', label: 'Sending account' },
      { key: 'connectionId', label: 'Connection id' },
      { key: 'invited', label: 'Invited' },
      { key: 'sent', label: 'Sent' },
      { key: 'failed', label: 'Failed' },
      { key: 'accepted', label: 'Accepted' },
      { key: 'declined', label: 'Declined' },
      { key: 'tentative', label: 'Maybe' },
      { key: 'noResponse', label: 'No reply' },
      { key: 'attended', label: 'Attended' },
      { key: 'noShow', label: 'No-show' },
    ],
    rows: out,
  };
}

export function buildCampaignVariantTable(rows: CampaignExportRow[]): ExportTable {
  const out: ExportRow[] = [];
  for (const { campaign, stats } of rows) {
    const tracked = stats.hasAttendance;
    for (const variant of stats.variants) {
      out.push({
        campaignId: campaign.id,
        campaign: campaign.name,
        variant: variant.variant,
        invited: variant.invited,
        queued: variant.queued,
        sent: variant.sent,
        failed: variant.failed,
        accepted: variant.accepted,
        declined: variant.declined,
        tentative: variant.tentative,
        noResponse: variant.noResponse,
        attended: tracked ? variant.attended : '',
        noShow: tracked ? variant.noShow : '',
        rsvpRate: variant.rsvpRate,
        acceptanceRate: variant.acceptanceRate,
        attendanceRate: tracked ? variant.attendanceRate : '',
      });
    }
  }
  return {
    columns: [
      { key: 'campaignId', label: 'Campaign id' },
      { key: 'campaign', label: 'Campaign' },
      { key: 'variant', label: 'Copy variant' },
      { key: 'invited', label: 'Invited' },
      { key: 'queued', label: 'Queued' },
      { key: 'sent', label: 'Sent' },
      { key: 'failed', label: 'Failed' },
      { key: 'accepted', label: 'Accepted' },
      { key: 'declined', label: 'Declined' },
      { key: 'tentative', label: 'Maybe' },
      { key: 'noResponse', label: 'No reply' },
      { key: 'attended', label: 'Attended' },
      { key: 'noShow', label: 'No-show' },
      { key: 'rsvpRate', label: 'RSVP rate (%)' },
      { key: 'acceptanceRate', label: 'Acceptance rate (%)' },
      { key: 'attendanceRate', label: 'Attendance rate (%)' },
    ],
    rows: out,
  };
}

/**
 * One row per call, from the latest sync only.
 *
 * `attended` is full attendance; brief visits are the `partial` bucket, and walk-ins are people
 * who joined without being on the invited list. A call that has never produced a report leaves
 * the attendance cells blank rather than claiming zero.
 */
export function buildCallsTable(
  rows: CallExportRow[],
  connectionNames: Record<string, string> = {},
): ExportTable {
  return {
    columns: [
      { key: 'callId', label: 'Call id' },
      { key: 'call', label: 'Call' },
      { key: 'type', label: 'Type' },
      { key: 'provider', label: 'Provider' },
      { key: 'startsAt', label: 'Starts' },
      { key: 'endsAt', label: 'Ends' },
      { key: 'status', label: 'Status' },
      { key: 'lastSyncedAt', label: 'Last synced' },
      { key: 'sendingAccount', label: 'Linked account' },
      { key: 'connectionId', label: 'Connection id' },
      { key: 'invitedSource', label: 'Invited list' },
      { key: 'invited', label: 'Invited' },
      { key: 'attended', label: 'Attended' },
      { key: 'briefVisits', label: 'Brief visits' },
      { key: 'noShows', label: 'No-shows' },
      { key: 'walkIns', label: 'Walk-ins' },
      { key: 'attendanceRate', label: 'Attendance rate (%)' },
      { key: 'pollQuestions', label: 'Poll questions' },
      { key: 'pollRespondents', label: 'Poll respondents' },
      { key: 'pollAnswers', label: 'Poll answers' },
      { key: 'qaEntries', label: 'Q&A entries' },
      { key: 'registrations', label: 'Registrations' },
      { key: 'callReportSentAt', label: 'Call report sent' },
      { key: 'resultsSentAt', label: 'Results sent' },
      { key: 'syncError', label: 'Last sync error' },
    ],
    rows: rows.map(({ session, report }) => {
      const briefVisits = report
        ? report.attended.filter((person) => person.status === 'partial').length
        : 0;
      return {
        callId: session.id,
        call: session.title,
        type: session.sessionType ?? 'meeting',
        provider: session.provider,
        startsAt: session.startTime,
        endsAt: session.endTime,
        status: session.status,
        lastSyncedAt: iso(session.lastSyncedAt),
        sendingAccount: session.connectionId ? (connectionNames[session.connectionId] ?? '') : '',
        connectionId: session.connectionId ?? '',
        invitedSource: report?.invitedSource ?? '',
        invited: report ? report.invitedCount : '',
        attended: report ? Math.max(0, report.attended.length - briefVisits) : '',
        briefVisits: report ? briefVisits : '',
        noShows: report ? report.noShow.length : '',
        walkIns: report ? report.attendedNotInvited.length : '',
        attendanceRate: report ? fractionToPercent(report.attendanceRate) : '',
        pollQuestions: report ? report.pollQuestionCount : '',
        pollRespondents: report ? report.pollRespondentCount : '',
        pollAnswers: report ? report.pollAnswerCount : '',
        qaEntries: report ? report.qa.length : '',
        registrations: report ? report.registrantCount : '',
        callReportSentAt: iso(session.rosterSentAt),
        resultsSentAt: iso(session.lastDispatchedAt),
        syncError: session.error ?? '',
      };
    }),
  };
}

