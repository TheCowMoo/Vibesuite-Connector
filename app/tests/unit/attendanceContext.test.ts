import { describe, it, expect } from 'vitest';
import { buildAttendanceContext } from '../../src/domain/attendanceContext';
import { buildReport } from '../../src/domain/attendance';
import { buildAttendanceSegments, segmentEntries } from '../../src/domain/attendanceSegments';
import type { SessionRecord } from '../../src/domain/sessionStore';

const START = '2026-01-01T10:00:00.000Z';
const END = '2026-01-01T11:00:00.000Z';

const session: SessionRecord = {
  id: 'sess-1',
  provider: 'zoom',
  sessionType: 'webinar',
  externalId: '123',
  title: 'Launch',
  startTime: START,
  endTime: END,
  status: 'synced',
  createdAt: 0,
};

function report() {
  return buildReport({
    sessionId: session.id,
    provider: 'zoom',
    sessionType: 'webinar',
    sessionTitle: 'Launch',
    invitedEmails: ['ada@example.com'],
    attendees: [
      {
        email: 'ada@example.com',
        name: 'Ada Lovelace',
        joinedAt: '2026-01-01T10:05:00.000Z',
        leftAt: '2026-01-01T10:50:00.000Z',
        durationSec: 2700,
        raw: { device: 'Mac', share_desktop: true },
      },
    ],
    polls: [
      {
        email: 'ada@example.com',
        question_details: [{ question: 'Which plan?', answer: 'Pro' }],
      },
    ],
    qa: [{ email: 'ada@example.com', question: 'SSO?', answer: 'Yes' }],
    registrantRows: [
      {
        email: 'ada@example.com',
        custom_questions: [{ title: 'Company', value: 'Analytical Engines' }],
      },
    ],
    sessionStart: START,
    sessionEnd: END,
  });
}

describe('buildAttendanceContext', () => {
  it('flattens new Zoom behavior fields for rules', () => {
    const r = report();
    const segments = buildAttendanceSegments(r);
    const entry = segmentEntries(segments).find((e) => e.person.email === 'ada@example.com');
    expect(entry).toBeDefined();

    const ctx = buildAttendanceContext(session, entry!.person, r, entry!.segment, segments);

    expect(ctx.pollCount).toBe('1');
    expect(ctx.pollRespondentCount).toBe('1');
    expect(ctx.pollQuestionCount).toBe('1');
    expect(ctx.pollAnsweredCount).toBe('1');
    expect(ctx.pollAnswerCount).toBe('1');
    expect(ctx.pollAnsweredAll).toBe('true');
    expect(ctx.pollAnswerText).toContain('Which plan?: Pro');
    expect(ctx.qaCount).toBe('1');
    expect(ctx.qaAskedCount).toBe('1');
    expect(ctx.qaAnsweredCount).toBe('1');
    expect(ctx.qaQuestionText).toBe('SSO?');
    expect(ctx.registrationAnswerCount).toBe('1');
    expect(ctx.registrationAnswerText).toContain('Company: Analytical Engines');
    expect(ctx.joinedLateMinutes).toBe('5');
    expect(ctx.leftEarlyMinutes).toBe('10');
    expect(ctx.attendedPortionPct).toBe('75');
    expect(ctx.zoomDevice).toBe('Mac');
    expect(ctx.zoomShareDesktop).toBe('true');
    expect(ctx.segment).toBe('attended');
    expect(ctx.sessionTitle).toBe('Launch');
  });

  it('leaves behavior fields empty for a no-show', () => {
    const r = buildReport({
      sessionId: session.id,
      provider: 'zoom',
      invitedEmails: ['absent@example.com'],
      attendees: [],
      sessionStart: START,
      sessionEnd: END,
    });
    const segments = buildAttendanceSegments(r);
    const entry = segmentEntries(segments).find((e) => e.person.email === 'absent@example.com');

    const ctx = buildAttendanceContext(session, entry!.person, r, entry!.segment, segments);
    expect(ctx.attendanceStatus).toBe('no_show');
    expect(ctx.pollAnsweredCount).toBe('0');
    expect(ctx.pollAnswerText).toBe('');
    expect(ctx.registrationAnswerCount).toBe('0');
    expect(ctx.zoomDevice).toBe('');
  });
});
