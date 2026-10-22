import { percent, type CampaignFunnel, type SenderAttribution } from './campaignStats';
import type { RecipientRecord } from './campaign';

/** One campaign, reduced to what the overview needs. */
export interface OverviewCampaign {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  recipients: RecipientRecord[];
  funnel: CampaignFunnel;
  perSender: SenderAttribution[];
}

export interface OverviewSession {
  id: string;
  title: string;
  startTime: string;
  attendedCount: number;
  noShowCount: number;
}

export interface StatsOverview {
  days: number;
  /** True when any campaign ever sent, or any session exists — independent of the window. */
  hasActivity: boolean;
  totals: {
    campaigns: number;
    activeCampaigns: number;
    /** Recipient rows actually sent inside the window. */
    invitations: number;
    /** Current state across every campaign, not windowed — "still waiting" is true right now. */
    pending: number;
    failed: number;
    sessions: number;
    attendances: number;
    noShows: number;
    acceptanceRate: number;
    attendanceRate: number;
  };
  rsvp: { accepted: number; declined: number; tentative: number; noResponse: number };
  daily: Array<{ date: string; sent: number }>;
  byMailbox: SenderAttribution[];
  topCampaigns: Array<{
    id: string;
    name: string;
    status: string;
    sent: number;
    accepted: number;
    attended: number;
  }>;
}

export interface StatsOverviewInput {
  campaigns: OverviewCampaign[];
  sessions: OverviewSession[];
  /** 1–365. The window is the last N calendar days, including today. */
  days: number;
  now: number;
}

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Fold every campaign and session into one overview.
 *
 * Two different windows live here on purpose, and mixing them would quietly lie:
 *
 * - **Invitations** are counted per recipient, by `sentAt`, so "last 7 days" means exactly that.
 * - **Replies and attendance** are per campaign / per session aggregates, so a campaign contributes
 *   its whole funnel once it sent anything inside the window. A person invited to two campaigns is
 *   still two invitations, which is why the UI says "invitations" rather than "people".
 * - **Pending and failed** are current state, not windowed: something still waiting today is still
 *   waiting regardless of which period you look at.
 */
export function buildStatsOverview(input: StatsOverviewInput): StatsOverview {
  const days = Math.min(365, Math.max(1, Math.floor(input.days)));
  const now = new Date(input.now);

  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const windowStart = todayStart - (days - 1) * 86400000;

  const daily: Array<{ date: string; sent: number }> = [];
  const dayIndex = new Map<string, number>();
  for (let i = 0; i < days; i += 1) {
    const date = dayKey(windowStart + i * 86400000);
    dayIndex.set(date, daily.length);
    daily.push({ date, sent: 0 });
  }

  let invitations = 0;
  let pending = 0;
  let failed = 0;
  let campaigns = 0;
  let activeCampaigns = 0;
  let hasActivity = false;

  const rsvp = { accepted: 0, declined: 0, tentative: 0, noResponse: 0 };
  let rsvpBase = 0;

  const mailboxes = new Map<string, SenderAttribution>();
  const top: StatsOverview['topCampaigns'] = [];

  for (const camp of input.campaigns) {
    if (camp.status === 'active') activeCampaigns += 1;
    if (camp.createdAt >= windowStart) campaigns += 1;
    if (camp.funnel.sent > 0) hasActivity = true;

    // Current state, deliberately not windowed.
    for (const recipient of camp.recipients) {
      if (recipient.status === 'pending') pending += 1;
      if (recipient.status === 'failed') failed += 1;
      if (recipient.status === 'sent') hasActivity = true;
    }

    // Recipient-level window: what the bar chart and the invitations KPI mean.
    let sentInWindow = 0;
    for (const recipient of camp.recipients) {
      if (recipient.status !== 'sent') continue;
      const at = recipient.sentAt ?? camp.createdAt;
      if (at < windowStart) continue;

      sentInWindow += 1;
      invitations += 1;
      const index = dayIndex.get(dayKey(at));
      if (index !== undefined) daily[index].sent += 1;
    }

    // Campaign aggregates only count once the campaign sent inside the window.
    if (!sentInWindow) continue;

    rsvp.accepted += camp.funnel.accepted;
    rsvp.declined += camp.funnel.declined;
    rsvp.tentative += camp.funnel.tentative;
    rsvp.noResponse += camp.funnel.noResponse;
    rsvpBase += camp.funnel.sent;

    for (const sender of camp.perSender) {
      const merged = mailboxes.get(sender.connectionId) ?? {
        connectionId: sender.connectionId,
        invited: 0,
        sent: 0,
        failed: 0,
        accepted: 0,
        declined: 0,
        tentative: 0,
        noResponse: 0,
        attended: 0,
        noShow: 0,
      };
      merged.invited += sender.invited;
      merged.sent += sender.sent;
      merged.failed += sender.failed;
      merged.accepted += sender.accepted;
      merged.declined += sender.declined;
      merged.tentative += sender.tentative;
      merged.noResponse += sender.noResponse;
      merged.attended += sender.attended;
      merged.noShow += sender.noShow;
      mailboxes.set(sender.connectionId, merged);
    }

    top.push({
      id: camp.id,
      name: camp.name,
      status: camp.status,
      sent: camp.funnel.sent,
      accepted: camp.funnel.accepted,
      attended: camp.funnel.attended,
    });
  }

  let sessions = 0;
  let attendances = 0;
  let noShows = 0;

  for (const session of input.sessions) {
    const startedAt = Date.parse(session.startTime);
    if (Number.isNaN(startedAt)) continue;
    // A linked call is activity even when it sits outside the selected window.
    hasActivity = true;
    if (startedAt < windowStart) continue;
    sessions += 1;
    attendances += session.attendedCount;
    noShows += session.noShowCount;
  }

  return {
    days,
    hasActivity,
    totals: {
      campaigns,
      activeCampaigns,
      invitations,
      pending,
      failed,
      sessions,
      attendances,
      noShows,
      acceptanceRate: percent(rsvp.accepted, rsvpBase),
      attendanceRate: percent(attendances, attendances + noShows),
    },
    rsvp,
    daily,
    byMailbox: Array.from(mailboxes.values()).sort((a, b) => b.sent - a.sent),
    topCampaigns: top.sort((a, b) => b.sent - a.sent || b.accepted - a.accepted).slice(0, 5),
  };
}
