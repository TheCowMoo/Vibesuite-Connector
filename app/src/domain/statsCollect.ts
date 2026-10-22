import { getAttendance } from './attendanceStore';
import { collectCampaignStats } from './campaignStatsCollect';
import { getRecipients, listCampaigns } from './campaignStore';
import { listSessions } from './sessionStore';
import {
  buildStatsOverview,
  type OverviewCampaign,
  type OverviewSession,
  type StatsOverview,
} from './statsOverview';

/**
 * Gather the overview's inputs, then let the pure reducer do the arithmetic.
 *
 * The dashboard needs both the frozen recipient rows (for the per-day series) and the campaign funnel
 * (for replies), so each campaign is read twice by two helpers that already exist for the campaign
 * detail view. Small installations pay a handful of Redis reads per load; keeping it simple beats a
 * second aggregation cache that could drift from the detail view.
 */
export async function collectStatsOverview(days: number, now = Date.now()): Promise<StatsOverview> {
  const campaigns = await listCampaigns();

  const overviewCampaigns = await Promise.all(campaigns.map(async (camp): Promise<OverviewCampaign> => {
    const [stats, recipients] = await Promise.all([collectCampaignStats(camp), getRecipients(camp.id)]);
    return {
      id: camp.id,
      name: camp.name,
      status: camp.status,
      createdAt: camp.createdAt,
      recipients,
      funnel: stats.funnel,
      perSender: stats.perSender,
    };
  }));

  const sessions = await listSessions();
  const overviewSessions = await Promise.all(sessions.map(async (session): Promise<OverviewSession> => {
    const report = await getAttendance(session.id);
    return {
      id: session.id,
      title: session.title,
      startTime: session.startTime,
      attendedCount: report?.attendedCount ?? 0,
      noShowCount: report?.noShowCount ?? 0,
    };
  }));

  return buildStatsOverview({ campaigns: overviewCampaigns, sessions: overviewSessions, days, now });
}
