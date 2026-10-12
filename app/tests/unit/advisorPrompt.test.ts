import { describe, it, expect } from 'vitest';
import {
  buildAdvisorPrompt,
  localRecommendations,
  sanitizeRecommendations,
} from '../../src/domain/advisorPrompt';
import type { AdvisorSnapshot, CampaignSnapshot, MailboxSnapshot } from '../../src/domain/advisorSnapshot';

function mailbox(over: Partial<MailboxSnapshot> = {}): MailboxSnapshot {
  return {
    label: 'Account A',
    enabled: true,
    mode: 'flat',
    dailyCap: 800,
    hourlyCap: 100,
    minDelayMs: 5000,
    window: { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5], timeZone: 'UTC' },
    capToday: 800,
    sentToday: 0,
    failedToday: 0,
    sentThisHour: 0,
    errorStreak: 0,
    cooling: false,
    history: [],
    ...over,
  };
}

function campaign(over: Partial<CampaignSnapshot> = {}): CampaignSnapshot {
  return {
    label: 'Bulk invite 1',
    status: 'active',
    spread: 'even',
    mailboxes: 2,
    invited: 100,
    queued: 0,
    sent: 100,
    failed: 0,
    accepted: 20,
    declined: 5,
    tentative: 3,
    noResponse: 72,
    attended: 10,
    noShow: 5,
    rsvpRate: 28,
    acceptanceRate: 20,
    attendanceRate: 43.5,
    hasAttendance: true,
    ...over,
  };
}

function snapshot(mailboxes: MailboxSnapshot[], campaigns: CampaignSnapshot[] = []): AdvisorSnapshot {
  return {
    generatedAt: 0,
    settings: {
      tickIntervalMs: 300000,
      defaultDailyCap: 800,
      defaultHourlyCap: 100,
      defaultMinDelayMs: 5000,
      cooldownOnErrors: 3,
      cooldownHours: 24,
    },
    mailboxes,
    campaigns,
  };
}

describe('buildAdvisorPrompt', () => {
  it('speaks in labels and never in identities', () => {
    const prompt = buildAdvisorPrompt(snapshot([mailbox({ label: 'Account A' })]));
    expect(prompt).toContain('Account A');
    expect(prompt).toContain('set_sender_daily_cap');
    expect(prompt).not.toContain('conn-123');
    expect(prompt).not.toContain('@');
  });

  it('states the safety ceilings', () => {
    const prompt = buildAdvisorPrompt(snapshot([mailbox()]));
    expect(prompt).toContain('2000');
    expect(prompt).toContain('500');
    expect(prompt).toContain('1000ms');
  });
});

describe('localRecommendations', () => {
  it('flags a cooling mailbox and pauses it', () => {
    const recs = localRecommendations(snapshot([mailbox({ cooling: true, errorStreak: 3 })]));
    expect(recs).toHaveLength(1);
    expect(recs[0].severity).toBe('critical');
    expect(recs[0].action?.kind).toBe('pause_sender');
    expect(recs[0].id).toBe('local-1');
    expect(recs[0].state).toBe('open');
  });

  it('offers to resume a paused mailbox', () => {
    const recs = localRecommendations(snapshot([mailbox({ enabled: false })]));
    expect(recs[0].action?.kind).toBe('resume_sender');
  });

  it('warns when the hourly ceiling is nearly reached', () => {
    const recs = localRecommendations(snapshot([mailbox({ hourlyCap: 100, sentThisHour: 95, capToday: 800, sentToday: 95 })]));
    expect(recs[0].title).toContain('close to its limit');
    const action = recs[0].action;
    expect(action?.kind).toBe('set_sender_hourly_cap');
    expect((action?.value as number) > 100).toBe(true);
  });

  it('suggests a higher daily cap after a clean full day', () => {
    const recs = localRecommendations(snapshot([mailbox({ dailyCap: 800, capToday: 800, sentToday: 780, failedToday: 0 })]));
    expect(recs[0].severity).toBe('info');
    expect(recs[0].action?.value).toBe(1000);
  });

  it('reacts to a failure rate above 10%', () => {
    const recs = localRecommendations(snapshot([mailbox({ sentToday: 100, failedToday: 10, minDelayMs: 5000 })]));
    expect(recs[0].severity).toBe('critical');
    expect(recs[0].action?.kind).toBe('set_sender_min_delay_ms');
    expect(recs[0].action?.value).toBe(10000);
  });

  it('warns when a live campaign sits on one mailbox', () => {
    const recs = localRecommendations(snapshot([], [campaign({ mailboxes: 1, queued: 500 })]));
    expect(recs).toHaveLength(1);
    expect(recs[0].severity).toBe('warning');
    expect(recs[0].action).toBeUndefined();
  });

  it('stays quiet when everything is healthy', () => {
    expect(localRecommendations(snapshot([mailbox({ sentToday: 100 })], [campaign()]))).toEqual([]);
  });
});

describe('sanitizeRecommendations', () => {
  it('clamps model numbers before they become actions', () => {
    const recs = sanitizeRecommendations({
      recommendations: [
        {
          title: 'Push mailbox A hard',
          severity: 'CRITICAL',
          rationale: 'because',
          action: { kind: 'set_sender_daily_cap', target: 'Account A', value: 999999 },
        },
      ],
    });

    expect(recs).toHaveLength(1);
    expect(recs[0].severity).toBe('critical');
    expect(recs[0].action?.value).toBe(5000);
  });

  it('downgrades an unknown action to advisory-only', () => {
    const recs = sanitizeRecommendations({
      recommendations: [{ title: 'Do something odd', action: { kind: 'wipe_everything', target: 'Account A' } }],
    });
    expect(recs[0].action).toBeUndefined();
    expect(recs[0].actionLabel).toBe('Information only');
    expect(recs[0].severity).toBe('info');
  });

  it('ignores junk payloads', () => {
    expect(sanitizeRecommendations(null)).toEqual([]);
    expect(sanitizeRecommendations({ recommendations: 'nope' })).toEqual([]);
    expect(sanitizeRecommendations({ recommendations: [null, 'x'] })).toEqual([]);
  });

  it('numbers ids from the given offset', () => {
    const recs = sanitizeRecommendations({ recommendations: [{ title: 'a' }, { title: 'b' }] }, 5);
    expect(recs.map((r) => r.id)).toEqual(['ai-6', 'ai-7']);
  });
});
