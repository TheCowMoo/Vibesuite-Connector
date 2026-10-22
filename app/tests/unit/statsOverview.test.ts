import { describe, it, expect } from 'vitest';
import { buildStatsOverview, type OverviewCampaign, type OverviewSession } from '../../src/domain/statsOverview';
import type { CampaignFunnel, SenderAttribution } from '../../src/domain/campaignStats';
import type { RecipientRecord } from '../../src/domain/campaign';

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0); // 23 Oct 2026, 12:00 UTC
const DAY = 86400000;

function funnel(over: Partial<CampaignFunnel> = {}): CampaignFunnel {
  return {
    invited: 0, queued: 0, sent: 0, failed: 0, accepted: 0, declined: 0,
    tentative: 0, noResponse: 0, attended: 0, noShow: 0,
    rsvpRate: 0, acceptanceRate: 0, attendanceRate: 0,
    ...over,
  };
}

function attribution(connectionId: string, over: Partial<SenderAttribution> = {}): SenderAttribution {
  return {
    connectionId, invited: 0, sent: 0, failed: 0, accepted: 0, declined: 0,
    tentative: 0, noResponse: 0, attended: 0, noShow: 0,
    ...over,
  };
}

function recipient(status: RecipientRecord['status'], sentAt?: number): RecipientRecord {
  return { email: 'person@example.com', connectionId: 's1', status, sentAt };
}

function campaign(over: Partial<OverviewCampaign> = {}): OverviewCampaign {
  return {
    id: 'camp-1', name: 'November webinar', status: 'active',
    createdAt: NOW - DAY, recipients: [], funnel: funnel(), perSender: [],
    ...over,
  };
}

function session(over: Partial<OverviewSession> = {}): OverviewSession {
  return {
    id: 'sess-1', title: 'Webinar', startTime: new Date(NOW - DAY).toISOString(),
    attendedCount: 0, noShowCount: 0,
    ...over,
  };
}

describe('buildStatsOverview', () => {
  it('returns zeroed totals and one bar per day for an empty account', () => {
    const out = buildStatsOverview({ campaigns: [], sessions: [], days: 7, now: NOW });
    expect(out.days).toBe(7);
    expect(out.daily).toHaveLength(7);
    expect(out.daily.every((d) => d.sent === 0)).toBe(true);
    expect(out.totals).toMatchObject({ invitations: 0, pending: 0, failed: 0, sessions: 0 });
    expect(out.hasActivity).toBe(false);
    expect(out.totals.acceptanceRate).toBe(0);
    expect(out.totals.attendanceRate).toBe(0);
    expect(out.topCampaigns).toEqual([]);
    expect(out.byMailbox).toEqual([]);
  });

  it('knows real history exists even when the window is empty', () => {
    const out = buildStatsOverview({
      campaigns: [],
      sessions: [session({ startTime: new Date(NOW - 40 * DAY).toISOString() })],
      days: 7, now: NOW,
    });
    expect(out.totals.sessions).toBe(0);
    expect(out.hasActivity).toBe(true);
  });

  it('counts only invitations sent inside the window, bucketed by day', () => {
    const out = buildStatsOverview({
      campaigns: [campaign({
        recipients: [
          recipient('sent', NOW - DAY),
          recipient('sent', NOW - 2 * DAY),
          recipient('sent', NOW - 30 * DAY),
          recipient('pending'),
        ],
      })],
      sessions: [], days: 7, now: NOW,
    });
    expect(out.totals.invitations).toBe(2);
    expect(out.daily.reduce((a, d) => a + d.sent, 0)).toBe(2);
    expect(out.totals.pending).toBe(1);
  });

  it('keeps pending and failed current rather than windowed', () => {
    const out = buildStatsOverview({
      campaigns: [campaign({ createdAt: NOW - 200 * DAY, recipients: [recipient('pending'), recipient('failed')] })],
      sessions: [], days: 7, now: NOW,
    });
    expect(out.totals.pending).toBe(1);
    expect(out.totals.failed).toBe(1);
    expect(out.totals.campaigns).toBe(0);
  });

  it('adds a campaign’s replies once it sent inside the window', () => {
    const out = buildStatsOverview({
      campaigns: [campaign({
        recipients: [recipient('sent', NOW - DAY)],
        funnel: funnel({ sent: 4, accepted: 1, declined: 2, tentative: 0, noResponse: 1 }),
      })],
      sessions: [], days: 7, now: NOW,
    });
    expect(out.rsvp).toEqual({ accepted: 1, declined: 2, tentative: 0, noResponse: 1 });
    expect(out.totals.acceptanceRate).toBe(25);
  });

  it('ignores replies from a campaign that sent nothing in the window', () => {
    const out = buildStatsOverview({
      campaigns: [campaign({ recipients: [recipient('sent', NOW - 40 * DAY)], funnel: funnel({ sent: 10, accepted: 5 }) })],
      sessions: [], days: 7, now: NOW,
    });
    expect(out.rsvp.accepted).toBe(0);
    expect(out.totals.acceptanceRate).toBe(0);
  });

  it('merges mailbox rows across campaigns', () => {
    const out = buildStatsOverview({
      campaigns: [
        campaign({ id: 'a', recipients: [recipient('sent', NOW - DAY)], perSender: [attribution('s1', { sent: 3, accepted: 1 })] }),
        campaign({
          id: 'b', recipients: [recipient('sent', NOW - DAY)],
          perSender: [attribution('s1', { sent: 2, accepted: 2 }), attribution('s2', { sent: 1 })],
        }),
      ],
      sessions: [], days: 7, now: NOW,
    });
    expect(out.byMailbox).toHaveLength(2);
    expect(out.byMailbox[0]).toMatchObject({ connectionId: 's1', sent: 5, accepted: 3 });
    expect(out.byMailbox[1]).toMatchObject({ connectionId: 's2', sent: 1 });
  });

  it('lists the five biggest campaigns by invitations sent', () => {
    const campaigns = Array.from({ length: 7 }, (_, i) => campaign({
      id: 'c' + i, recipients: [recipient('sent', NOW - DAY)], funnel: funnel({ sent: 10 + i }),
    }));
    const out = buildStatsOverview({ campaigns, sessions: [], days: 7, now: NOW });
    expect(out.topCampaigns).toHaveLength(5);
    expect(out.topCampaigns.map((c) => c.sent)).toEqual([16, 15, 14, 13, 12]);
  });

  it('counts sessions in the window and derives attendance rate', () => {
    const out = buildStatsOverview({
      campaigns: [],
      sessions: [
        session({ id: 'a', attendedCount: 30, noShowCount: 10 }),
        session({ id: 'b', startTime: new Date(NOW - 60 * DAY).toISOString(), attendedCount: 5, noShowCount: 5 }),
      ],
      days: 7, now: NOW,
    });
    expect(out.totals.sessions).toBe(1);
    expect(out.totals.attendances).toBe(30);
    expect(out.totals.noShows).toBe(10);
    expect(out.totals.attendanceRate).toBe(75);
  });

  it('counts campaigns created in the window, and active ones regardless of age', () => {
    const out = buildStatsOverview({
      campaigns: [
        campaign({ id: 'new', createdAt: NOW - 2 * DAY, status: 'draft' }),
        campaign({ id: 'old', createdAt: NOW - 90 * DAY, status: 'active' }),
      ],
      sessions: [], days: 7, now: NOW,
    });
    expect(out.totals.campaigns).toBe(1);
    expect(out.totals.activeCampaigns).toBe(1);
  });

  it('ignores a session with an unparseable start time', () => {
    const out = buildStatsOverview({
      campaigns: [], sessions: [session({ startTime: 'not a date' })], days: 7, now: NOW,
    });
    expect(out.totals.sessions).toBe(0);
  });
});
