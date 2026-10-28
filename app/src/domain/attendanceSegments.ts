import type { AttendancePerson, AttendanceReport } from './attendance';
import type { AttendanceTags } from './connection';

export const ATTENDANCE_SEGMENTS = ['attended', 'partial', 'no_show', 'not_invited'] as const;
export type AttendanceSegment = (typeof ATTENDANCE_SEGMENTS)[number];

export interface SegmentPerson {
  email?: string;
  name?: string;
  status: AttendancePerson['status'];
  durationSec?: number;
  minutes?: number;
  joinedAt?: string;
  leftAt?: string;
  attentivenessScore?: number;
  isGuest?: boolean;
  registrantId?: string;
  userId?: string;
  participantId?: string;
  customerKey?: string;
}

export interface AttendanceSegmentCounts {
  invited: number;
  /** Fully attended (duration at or above the threshold). */
  attended: number;
  partial: number;
  noShow: number;
  notInvited: number;
  /** Percentage, one decimal, 0–100. */
  attendanceRate: number;
}

export interface AttendanceSegments {
  attended: SegmentPerson[];
  partial: SegmentPerson[];
  no_show: SegmentPerson[];
  not_invited: SegmentPerson[];
  counts: AttendanceSegmentCounts;
}

function toSegmentPerson(p: AttendancePerson): SegmentPerson {
  return {
    email: p.email,
    name: p.name,
    status: p.status,
    durationSec: p.durationSec,
    minutes: p.durationSec === undefined ? undefined : Math.round(p.durationSec / 60),
    joinedAt: p.joinedAt,
    leftAt: p.leftAt,
    attentivenessScore: p.attentivenessScore,
    isGuest: p.isGuest,
    registrantId: p.registrantId,
    userId: p.userId,
    participantId: p.participantId,
    customerKey: p.customerKey,
  };
}

function keyOf(p: SegmentPerson): string {
  return (p.email || p.name || '').toLowerCase();
}

/** Stable order, so a roster revision only changes when the content does. */
function sortPeople(people: SegmentPerson[]): SegmentPerson[] {
  return people.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Split the attendance report into the four buckets an operator (and a CRM) cares about.
 *
 * `attended` holds only people who met the minimum-minutes threshold; shorter visits go to
 * `partial`, and people who joined without being on the invited list go to `not_invited` — never
 * into no-shows, because nobody invited them.
 */
export function buildAttendanceSegments(report: AttendanceReport): AttendanceSegments {
  const attended: SegmentPerson[] = [];
  const partial: SegmentPerson[] = [];
  const notInvited: SegmentPerson[] = [];

  for (const person of report.attended ?? []) {
    (person.status === 'partial' ? partial : attended).push(toSegmentPerson(person));
  }
  for (const person of report.attendedNotInvited ?? []) {
    notInvited.push(toSegmentPerson(person));
  }

  const noShow: SegmentPerson[] = (report.noShow ?? []).map((email) => ({ email, status: 'no_show' }));

  return {
    attended: sortPeople(attended),
    partial: sortPeople(partial),
    no_show: sortPeople(noShow),
    not_invited: sortPeople(notInvited),
    counts: {
      invited: report.invitedCount,
      attended: attended.length,
      partial: partial.length,
      noShow: noShow.length,
      notInvited: notInvited.length,
      attendanceRate: Math.round((report.attendanceRate ?? 0) * 1000) / 10,
    },
  };
}

/** Flatten the segments into the per-person dispatch order. */
export function segmentEntries(
  segments: AttendanceSegments,
): Array<{ segment: AttendanceSegment; person: SegmentPerson }> {
  const out: Array<{ segment: AttendanceSegment; person: SegmentPerson }> = [];
  for (const segment of ATTENDANCE_SEGMENTS) {
    for (const person of segments[segment]) out.push({ segment, person });
  }
  return out;
}

export interface SegmentTagFallbacks {
  attended: string;
  noShow: string;
  notInvited: string;
}

/**
 * Which GHL tag a segment gets.
 *
 * `partial` falls back to the attended tag on purpose: before segments existed every matched person
 * got the attended tag, and silently inventing a new one would break existing workflows. Set a
 * partial tag explicitly to separate them.
 */
export function segmentTag(
  segment: AttendanceSegment,
  tags: AttendanceTags | undefined,
  fallback: SegmentTagFallbacks,
): string {
  switch (segment) {
    case 'no_show':
      return tags?.noShow || fallback.noShow;
    case 'not_invited':
      return tags?.notInvited || fallback.notInvited;
    case 'partial':
      return tags?.partial || fallback.attended;
    case 'attended':
      return tags?.attended || fallback.attended;
  }
}
