import { getAttendance } from './attendanceStore';
import { collectCampaignStats } from './campaignStatsCollect';
import { getCampaign, getRecipients, listCampaigns } from './campaignStore';
import { listConnections } from './connectionStore';
import { getSession, listSessions, type SessionRecord } from './sessionStore';
import { collectStatsOverview } from './statsCollect';
import { overviewWindowStart } from './statsOverview';
import type { Campaign } from './campaign';
import {
  buildCallsTable,
  buildCampaignSenderTable,
  buildCampaignTable,
  buildCampaignVariantTable,
  buildDailyTable,
  buildMailboxTable,
  buildSummaryTable,
  type CampaignExportRow,
  type ExportScope,
  type ExportTable,
} from './statsExport';

export class StatsExportNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsExportNotFoundError';
  }
}

export interface StatsExportRequest {
  scope: ExportScope;
  /** null means all time. Overview scopes fall back to the 365-day ceiling. */
  days: number | null;
  campaignId?: string;
  sessionId?: string;
  /** Injectable for tests and deterministic filenames. */
  now?: number;
}

/**
 * Build one export table from data that already exists.
 *
 * Nothing is cached or persisted: a download always reflects the same stores the dashboard and the
 * campaign/call detail views read, so an export cannot disagree with the pages.
 */
export async function collectStatsExport(request: StatsExportRequest): Promise<ExportTable> {
  const now = request.now ?? Date.now();
  switch (request.scope) {
    case 'summary':
    case 'daily':
    case 'mailboxes':
      return collectOverviewExport(request.scope, request.days, now);
    case 'calls':
      return collectCallExport(request, now);
    case 'campaign-senders':
    case 'campaign-variants':
    case 'campaigns':
      return collectCampaignExport(request, now);
  }
}

async function collectOverviewExport(
  scope: ExportScope,
  days: number | null,
  now: number,
): Promise<ExportTable> {
  const overview = await collectStatsOverview(days ?? 365, now);
  if (scope === 'summary') return buildSummaryTable(overview);
  if (scope === 'daily') return buildDailyTable(overview);
  return buildMailboxTable(overview, await connectionNames());
}

async function connectionNames(): Promise<Record<string, string>> {
  const connections = await listConnections();
  const names: Record<string, string> = {};
  for (const conn of connections) names[conn.id] = conn.name || conn.googleCalendarId;
  return names;
}

async function collectCallExport(request: StatsExportRequest, now: number): Promise<ExportTable> {
  let sessions: SessionRecord[];
  if (request.sessionId) {
    const one = await getSession(request.sessionId);
    if (!one) throw new StatsExportNotFoundError('call not found');
    sessions = [one];
  } else {
    sessions = await listSessions();
    if (request.days !== null) {
      const start = overviewWindowStart(request.days, now);
      sessions = sessions.filter((session) => {
        const startedAt = Date.parse(session.startTime);
        return !Number.isNaN(startedAt) && startedAt >= start;
      });
    }
  }

  const [reports, names] = await Promise.all([
    Promise.all(sessions.map((session) => getAttendance(session.id))),
    connectionNames(),
  ]);

  return buildCallsTable(
    sessions.map((session, index) => ({ session, report: reports[index] ?? null })),
    names,
  );
}

async function collectCampaignExport(request: StatsExportRequest, now: number): Promise<ExportTable> {
  let campaigns: Campaign[];
  if (request.campaignId) {
    const one = await getCampaign(request.campaignId);
    if (!one) throw new StatsExportNotFoundError('campaign not found');
    campaigns = [one];
  } else {
    campaigns = await listCampaigns();
    if (request.days !== null) {
      const start = overviewWindowStart(request.days, now);
      const flags = await Promise.all(campaigns.map((campaign) => sentInWindow(campaign, start)));
      campaigns = campaigns.filter((_campaign, index) => flags[index]);
    }
  }

  const hasLinkedCall = campaigns.some((campaign) => !!campaign.sessionId);
  const needsNames = request.scope === 'campaign-senders';

  const [rows, sessions, names] = await Promise.all([
    Promise.all(
      campaigns.map(async (campaign): Promise<CampaignExportRow> => ({
        campaign,
        stats: await collectCampaignStats(campaign),
      })),
    ),
    hasLinkedCall ? listSessions() : Promise.resolve([] as SessionRecord[]),
    needsNames ? connectionNames() : Promise.resolve({} as Record<string, string>),
  ]);

  const callTitles: Record<string, string> = {};
  for (const session of sessions) callTitles[session.id] = session.title;

  if (request.scope === 'campaign-senders') return buildCampaignSenderTable(rows, names);
  if (request.scope === 'campaign-variants') return buildCampaignVariantTable(rows);
  return buildCampaignTable(rows, callTitles);
}

/** Same window rule as the overview: a campaign belongs to the period if it sent inside it. */
async function sentInWindow(campaign: Campaign, windowStart: number): Promise<boolean> {
  const recipients = await getRecipients(campaign.id);
  return recipients.some(
    (recipient) => recipient.status === 'sent' && (recipient.sentAt ?? campaign.createdAt) >= windowStart,
  );
}
