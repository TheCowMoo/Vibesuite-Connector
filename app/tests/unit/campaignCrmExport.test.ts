import { describe, expect, it } from 'vitest';
import type { CampaignCrmRow } from '../../src/domain/campaignCrm';
import { buildCampaignCrmTable } from '../../src/domain/campaignCrmExport';
import { toCsv } from '../../src/domain/statsExport';
import type { ZoomBehavior } from '../../src/domain/zoomBehavior';

const behavior = {
  pollAnswers: [{ question: 'Which plan?', answer: 'Pro' }],
  qa: [{ question: 'Is it recorded?', answer: 'Yes' }],
  registrationAnswers: [{ question: 'Company', answer: 'Analytical' }],
  pollQuestions: ['Which plan?'],
  pollQuestionCount: 1,
  pollAnsweredCount: 1,
  qaAskedCount: 1,
  qaAnsweredCount: 1,
  registrationAnswerCount: 1,
  pollAnswerText: 'Which plan?: Pro',
  qaQuestionText: 'Is it recorded?',
  registrationAnswerText: 'Company: Analytical',
  joinedLateMinutes: 5,
  leftEarlyMinutes: 2,
  attendedPortionPct: 80,
  device: 'Mac',
  location: 'London',
  networkType: 'Wifi',
  camera: 'HD',
  microphone: 'Built-in',
  shareDesktop: true,
} as ZoomBehavior;

const row: CampaignCrmRow = {
  key: 'ada@example.com',
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  company: 'Analytical Engines',
  phone: '123',
  walkIn: false,
  connectionId: 'c1',
  senderName: 'Ada sender',
  variant: 'A',
  sendStatus: 'sent',
  sentAt: Date.UTC(2026, 10, 1, 10),
  eventId: 'e1',
  rsvp: 'accepted',
  rsvpHistory: [
    { status: 'needsAction', at: Date.UTC(2026, 10, 1, 9), initial: true },
    { status: 'accepted', at: Date.UTC(2026, 10, 1, 12) },
  ],
  zoom: 'attended',
  joinedAt: '2026-11-01T10:05:00Z',
  durationSec: 600,
  attentivenessScore: 90,
  behavior,
  note: { followUp: 'contacted', note: 'Asked for a demo', updatedAt: Date.UTC(2026, 10, 2), updatedBy: 'Nate' },
};

describe('buildCampaignCrmTable', () => {
  it('flattens campaign, RSVP history, Zoom behavior and notes into CSV columns', () => {
    const table = buildCampaignCrmTable([row], 'November webinar');
    const header = table.columns.map((column) => column.label);
    expect(header).toContain('RSVP history');
    expect(header).toContain('Follow-up');
    expect(table.rows[0]).toMatchObject({
      campaign: 'November webinar',
      name: 'Ada Lovelace',
      rsvp: 'Yes',
      zoom: 'Attended',
      sendStatus: 'Sent',
      followUp: 'Contacted',
      note: 'Asked for a demo',
      polls: 'Which plan?: Pro',
      qa: 'Is it recorded? -> Yes',
      registration: 'Company: Analytical',
      shared: 'desktop',
      durationMin: 10,
    });
    expect(String(table.rows[0].rsvpHistory)).toContain('(started)');
    expect(String(table.rows[0].rsvpHistory)).toContain('Yes@');
    expect(String(table.rows[0].rsvpHistory)).toContain('No reply@');
  });

  it('escapes notes and answers through the shared CSV writer', () => {
    const csv = toCsv(buildCampaignCrmTable([
      { ...row, note: { followUp: 'todo', note: 'Line one\nLine "two", with comma' } },
    ], 'Webinar'));
    expect(csv).toContain('"Line one\nLine ""two"", with comma"');
  });
});
