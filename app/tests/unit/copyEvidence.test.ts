import { describe, expect, it } from 'vitest';
import type { Campaign } from '../../src/domain/campaign';
import type { CampaignFunnel, CampaignStats } from '../../src/domain/campaignStats';
import { buildCopyEvidence, plainCopyForAi } from '../../src/domain/copyEvidence';

function funnel(overrides: Partial<CampaignFunnel> = {}): CampaignFunnel {
  return {
    invited: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    accepted: 0,
    declined: 0,
    tentative: 0,
    noResponse: 0,
    attended: 0,
    noShow: 0,
    failedRate: 0,
    rsvpRate: 0,
    acceptanceRate: 0,
    responseRate: 0,
    attendanceRate: 0,
    ...overrides,
  };
}

function campaign(): Campaign {
  return {
    id: 'camp1',
    name: 'Webinar',
    status: 'draft',
    listId: 'list1',
    segments: [],
    event: { summary: 'Base', start: '2026-11-20T10:00:00Z', end: '2026-11-20T11:00:00Z' },
    copyVariants: [
      { id: 'A', summary: 'Join us', description: '<p>Hello <strong>there</strong> https://example.com</p>' },
      { id: 'B', summary: 'A different subject', description: 'Different words.' },
    ],
    senders: [{ connectionId: 'c1', enabled: true, priority: 5 }],
    distribution: { mode: 'even' },
    includeAlreadyInvited: false,
    createdAt: 1,
  };
}

function stats(hasAttendance = true): CampaignStats {
  return {
    funnel: funnel({
      invited: 60,
      sent: 60,
      accepted: 16,
      tentative: 6,
      declined: 4,
      noResponse: 34,
      attended: 8,
      noShow: 14,
    }),
    perSender: [],
    variants: [
      {
        variant: 'A',
        ...funnel({
          invited: 40,
          sent: 40,
          accepted: 10,
          tentative: 2,
          declined: 2,
          noResponse: 26,
          attended: 6,
          noShow: 6,
        }),
      },
      {
        variant: 'B',
        ...funnel({
          invited: 20,
          sent: 20,
          accepted: 6,
          tentative: 4,
          declined: 2,
          noResponse: 8,
          attended: 2,
          noShow: 8,
        }),
      },
    ],
    hasAttendance,
  };
}

describe('buildCopyEvidence', () => {
  it('joins copy with variant funnels and computes the scorecard', () => {
    const out = buildCopyEvidence(campaign(), stats(), 'balanced', 123);

    expect(out.generatedAt).toBe(123);
    expect(out.hasAttendance).toBe(true);
    expect(out.variants[0]).toMatchObject({
      id: 'A',
      summary: 'Join us',
      description: 'Hello there [link removed]',
      sent: 40,
      accepted: 10,
      acceptanceRate: 25,
      yesRate: 83.3,
      showUpRate: 50,
      attendedPerSent: 15,
      sampleLabel: 'directional',
      hasAttendance: true,
    });
    expect(out.variants[1]).toMatchObject({
      id: 'B',
      sent: 20,
      acceptanceRate: 30,
      yesRate: 60,
      showUpRate: 20,
      attendedPerSent: 10,
      sampleLabel: 'small',
    });
    expect(out.aggregate).toMatchObject({
      sent: 60,
      accepted: 16,
      acceptanceRate: 26.7,
      yesRate: 72.7,
      showUpRate: 36.4,
    });
    expect(out.dataQuality.join(' ')).toContain('small samples');
    expect(out.dataQuality.join(' ')).toContain('more than one element');
    expect(out.dataQuality.join(' ')).toContain('Brief Zoom visits');
  });

  it('marks missing attendance as unmeasured and never invents a show-up rate', () => {
    const out = buildCopyEvidence(campaign(), stats(false), 'show_up');

    expect(out.hasAttendance).toBe(false);
    expect(out.variants[0].hasAttendance).toBe(false);
    expect(out.dataQuality.join(' ')).toContain('not measured, not zero');
  });

  it('strips markup and links from copy sent to the AI', () => {
    expect(plainCopyForAi('<p>Hello <strong>there</strong> https://example.com</p>')).toBe(
      'Hello there [link removed]',
    );
  });
});
