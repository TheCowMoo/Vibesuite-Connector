import { describe, it, expect } from 'vitest';
import { buildReport } from '../../src/domain/attendance';
import {
  buildAttendanceSegments,
  segmentEntries,
  segmentTag,
} from '../../src/domain/attendanceSegments';

function report() {
  return buildReport({
    sessionId: 's1',
    provider: 'zoom',
    sessionTitle: 'Q3 webinar',
    invitedSource: 'campaign',
    invitedEmails: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'],
    attendees: [
      { email: 'walkin@x.com', durationSec: 300 },
      { email: 'b@x.com', durationSec: 30 },
      { email: 'a@x.com', durationSec: 600 },
      { email: 'fast@x.com', durationSec: 20 },
      { name: 'Anonymous', durationSec: 120 },
    ],
    minSeconds: 60,
  });
}

describe('buildAttendanceSegments', () => {
  it('splits matched attendees into attended and partial', () => {
    const segments = buildAttendanceSegments(report());
    expect(segments.attended.map((p) => p.email)).toEqual(['a@x.com']);
    expect(segments.partial.map((p) => p.email)).toEqual(['b@x.com']);
  });

  it('puts everyone who was not on the invited list into not_invited', () => {
    const segments = buildAttendanceSegments(report());
    expect(segments.not_invited.map((p) => p.email ?? p.name)).toEqual(['Anonymous', 'fast@x.com', 'walkin@x.com']);
  });

  it('keeps no-shows to people who were actually invited', () => {
    const segments = buildAttendanceSegments(report());
    expect(segments.no_show.map((p) => p.email)).toEqual(['c@x.com', 'd@x.com']);
    expect(segments.counts).toEqual({
      invited: 4,
      attended: 1,
      partial: 1,
      noShow: 2,
      notInvited: 3,
      attendanceRate: 50,
    });
  });

  it('reports zero counts for a report with no audience', () => {
    const segments = buildAttendanceSegments(
      buildReport({ sessionId: 's2', provider: 'zoom', invitedEmails: [], attendees: [] }),
    );
    expect(segments.counts).toEqual({
      invited: 0,
      attended: 0,
      partial: 0,
      noShow: 0,
      notInvited: 0,
      attendanceRate: 0,
    });
    expect(segmentEntries(segments)).toEqual([]);
  });
});

describe('segmentEntries', () => {
  it('orders entries by segment and then by person', () => {
    const entries = segmentEntries(buildAttendanceSegments(report()));
    expect(entries.map((e) => e.segment)).toEqual([
      'attended',
      'partial',
      'no_show',
      'no_show',
      'not_invited',
      'not_invited',
      'not_invited',
    ]);
    expect(entries[3].person.email).toBe('d@x.com');
  });
});

describe('segmentTag', () => {
  const fallback = { attended: 'attended', noShow: 'no-show', notInvited: 'not-invited' };

  it('uses the configured tag when there is one', () => {
    expect(segmentTag('no_show', { noShow: 'missed' }, fallback)).toBe('missed');
    expect(segmentTag('not_invited', { notInvited: 'walk-in' }, fallback)).toBe('walk-in');
  });

  it('falls back to the attended tag for partial, so existing workflows do not change', () => {
    expect(segmentTag('partial', undefined, fallback)).toBe('attended');
    expect(segmentTag('partial', { partial: 'short' }, fallback)).toBe('short');
  });

  it('falls back to the env defaults for the rest', () => {
    expect(segmentTag('attended', undefined, fallback)).toBe('attended');
    expect(segmentTag('no_show', {}, fallback)).toBe('no-show');
    expect(segmentTag('not_invited', {}, fallback)).toBe('not-invited');
  });
});
