import { describe, it, expect } from 'vitest';
import { buildReport } from '../../src/domain/attendance';
import { buildAttendanceSegments } from '../../src/domain/attendanceSegments';
import { buildRosterPayloads, normalizeRosterShape, stableRevision } from '../../src/domain/attendanceRoster';

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
  it('builds one payload per non-empty segment when asked for segments', () => {
    const payloads = buildRosterPayloads(segments(), { ...meta, generatedAt: '2026-10-29T00:00:00.000Z' }, 'segments');
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

describe('flat call report', () => {
  const flat = (generatedAt?: string) => buildRosterPayloads(segments(), { ...meta, generatedAt }, 'flat');

  it('sends one request per call with everyone in one list', () => {
    const payloads = flat('2026-10-29T00:00:00.000Z');
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    expect(payload.event).toBe('attendance.call');
    if (payload.event !== 'attendance.call') return;
    expect(payload.count).toBe(4);
    expect(payload.people.map((p) => [p.email, p.result])).toEqual([
      ['a@x.com', 'attended'],
      ['b@x.com', 'partial'],
      ['c@x.com', 'no_show'],
      ['walkin@x.com', 'not_invited'],
    ]);
    expect(payload.counts).toEqual(segments().counts);
  });

  it('puts the result on every person, including no-shows without a name', () => {
    const payload = flat()[0];
    if (payload.event !== 'attendance.call') throw new Error('expected a flat payload');
    expect(payload.people.every((p) => typeof p.result === 'string')).toBe(true);
    expect(payload.people.find((p) => p.result === 'no_show')).toMatchObject({
      email: 'c@x.com',
      status: 'no_show',
    });
  });

  it('is the default shape for new configurations', () => {
    expect(buildRosterPayloads(segments(), meta)[0].event).toBe('attendance.call');
  });

  it('sends nothing when the report has no people', () => {
    const empty = buildAttendanceSegments(
      buildReport({ sessionId: 'sess_1', provider: 'zoom', invitedEmails: [], attendees: [] }),
    );
    expect(buildRosterPayloads(empty, meta, 'flat')).toEqual([]);
  });

  it('keeps the revision stable across generatedAt and changes with the audience', () => {
    const first = flat('2026-10-29T00:00:00.000Z')[0];
    const second = flat('2026-10-29T02:00:00.000Z')[0];
    expect(first.revision).toBe(second.revision);

    const changed = buildRosterPayloads(
      buildAttendanceSegments(
        buildReport({
          sessionId: 'sess_1',
          provider: 'zoom',
          invitedEmails: ['a@x.com'],
          attendees: [{ email: 'a@x.com', durationSec: 600 }],
        }),
      ),
      meta,
      'flat',
    )[0];
    expect(changed.revision).not.toBe(first.revision);
  });
});

describe('normalizeRosterShape', () => {
  it('accepts the three shapes and falls back otherwise', () => {
    expect(normalizeRosterShape('flat')).toBe('flat');
    expect(normalizeRosterShape('segments')).toBe('segments');
    expect(normalizeRosterShape('session')).toBe('session');
    expect(normalizeRosterShape(undefined)).toBe('flat');
    expect(normalizeRosterShape('bogus')).toBe('flat');
    expect(normalizeRosterShape(undefined, 'segments')).toBe('segments');
  });
});
