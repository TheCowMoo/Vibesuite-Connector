import { describe, it, expect } from 'vitest';
import { buildReport } from '../../src/domain/attendance';
import { buildAttendanceSegments } from '../../src/domain/attendanceSegments';
import { buildRosterPayloads, stableRevision } from '../../src/domain/attendanceRoster';

function segments() {
  return buildAttendanceSegments(
    buildReport({
      sessionId: 'sess_1',
      provider: 'zoom',
      sessionTitle: 'Q3 webinar',
      sessionType: 'webinar',
      invitedSource: 'campaign',
      invitedEmails: ['a@x.com', 'b@x.com', 'c@x.com'],
      attendees: [
        { email: 'a@x.com', durationSec: 600 },
        { email: 'b@x.com', durationSec: 30 },
        { email: 'walkin@x.com', durationSec: 300 },
      ],
      minSeconds: 60,
    }),
  );
}

const meta = { sessionId: 'sess_1', sessionTitle: 'Q3 webinar', sessionType: 'webinar', provider: 'zoom', invitedSource: 'campaign' };

describe('buildRosterPayloads', () => {
  it('builds one payload per non-empty segment by default', () => {
    const payloads = buildRosterPayloads(segments(), { ...meta, generatedAt: '2026-10-29T00:00:00.000Z' });
    expect(payloads.map((p) => (p.event === 'attendance.segment' ? p.segment : p.event))).toEqual([
      'attended',
      'partial',
      'no_show',
      'not_invited',
    ]);
    const attended = payloads[0];
    expect(attended.event).toBe('attendance.segment');
    if (attended.event === 'attendance.segment') {
      expect(attended.count).toBe(1);
      expect(attended.people[0].email).toBe('a@x.com');
      expect(attended.counts.notInvited).toBe(1);
    }
  });

  it('builds one snapshot with every segment when asked for session shape', () => {
    const payloads = buildRosterPayloads(segments(), meta, 'session');
    expect(payloads).toHaveLength(1);
    const only = payloads[0];
    expect(only.event).toBe('attendance.session');
    if (only.event === 'attendance.session') {
      expect(only.segments.attended).toHaveLength(1);
      expect(only.segments.partial).toHaveLength(1);
      expect(only.segments.no_show).toHaveLength(1);
      expect(only.segments.not_invited).toHaveLength(1);
    }
  });

  it('keeps the revision stable when only the generation time changes', () => {
    const first = buildRosterPayloads(segments(), { ...meta, generatedAt: '2026-10-29T00:00:00.000Z' });
    const second = buildRosterPayloads(segments(), { ...meta, generatedAt: '2026-10-29T02:00:00.000Z' });
    expect(first[0].revision).toBe(second[0].revision);
  });

  it('changes the revision when the audience changes', () => {
    const before = buildRosterPayloads(segments(), meta)[0];
    const after = buildRosterPayloads(
      buildAttendanceSegments(
        buildReport({
          sessionId: 'sess_1',
          provider: 'zoom',
          invitedEmails: ['a@x.com', 'b@x.com', 'c@x.com'],
          attendees: [{ email: 'a@x.com', durationSec: 600 }],
        }),
      ),
      meta,
    )[0];
    expect(before.revision).not.toBe(after.revision);
  });

  it('hashes deterministically', () => {
    expect(stableRevision({ b: 1, a: 2 })).toBe(stableRevision({ b: 1, a: 2 }));
    expect(stableRevision({ a: 1 })).not.toBe(stableRevision({ a: 2 }));
  });
});
