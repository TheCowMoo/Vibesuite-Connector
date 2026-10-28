import { createHash } from 'node:crypto';
import { ATTENDANCE_SEGMENTS, type AttendanceSegment, type AttendanceSegments, type SegmentPerson } from './attendanceSegments';

export type RosterShape = 'segments' | 'session';

export interface RosterMeta {
  sessionId: string;
  sessionTitle?: string;
  sessionType?: string;
  provider?: string;
  invitedSource?: string;
  /** Injectable for tests. Defaults to now. */
  generatedAt?: string;
}

interface RosterBase {
  version: 1;
  sessionId: string;
  sessionTitle?: string;
  sessionType?: string;
  provider?: string;
  invitedSource?: string;
  counts: AttendanceSegments['counts'];
  generatedAt: string;
  revision: string;
}

export interface SegmentRosterPayload extends RosterBase {
  event: 'attendance.segment';
  segment: AttendanceSegment;
  count: number;
  people: SegmentPerson[];
}

export interface SessionRosterPayload extends RosterBase {
  event: 'attendance.session';
  segments: Record<AttendanceSegment, SegmentPerson[]>;
}

export type RosterPayload = SegmentRosterPayload | SessionRosterPayload;

export function stableRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function metaFields(meta: RosterMeta) {
  return {
    version: 1 as const,
    sessionId: meta.sessionId,
    sessionTitle: meta.sessionTitle,
    sessionType: meta.sessionType,
    provider: meta.provider,
    invitedSource: meta.invitedSource,
  };
}

/** Only the fields a roster consumer needs — not the provider's internal ids and raw payload. */
function rosterPerson(person: SegmentPerson): SegmentPerson {
  return {
    email: person.email,
    name: person.name,
    status: person.status,
    minutes: person.minutes,
    joinedAt: person.joinedAt,
    leftAt: person.leftAt,
  };
}

function rosterSegment(people: SegmentPerson[]): SegmentPerson[] {
  return people.map(rosterPerson);
}

/**
 * Build the external roster payload(s).
 *
 * `segments` produces one request per non-empty segment (the default); `session` produces a single
 * snapshot containing all four. The revision excludes `generatedAt`, so the same result yields the
 * same revision across syncs and does not get resent.
 */
export function buildRosterPayloads(
  segments: AttendanceSegments,
  meta: RosterMeta,
  shape: RosterShape = 'segments',
): RosterPayload[] {
  const generatedAt = meta.generatedAt ?? new Date().toISOString();

  if (shape === 'session') {
    const base = {
      event: 'attendance.session' as const,
      ...metaFields(meta),
      counts: segments.counts,
      segments: {
        attended: rosterSegment(segments.attended),
        partial: rosterSegment(segments.partial),
        no_show: rosterSegment(segments.no_show),
        not_invited: rosterSegment(segments.not_invited),
      },
    };
    return [{ ...base, generatedAt, revision: stableRevision(base) }];
  }

  return ATTENDANCE_SEGMENTS.filter((segment) => segments[segment].length > 0).map((segment) => {
    const base = {
      event: 'attendance.segment' as const,
      ...metaFields(meta),
      counts: segments.counts,
      segment,
      count: segments[segment].length,
      people: rosterSegment(segments[segment]),
    };
    return { ...base, generatedAt, revision: stableRevision(base) };
  });
}

/** Shape of the `roster` block returned by the dispatch API and stored on the session. */
export interface RosterDeliveryResult {
  sent: number;
  skipped: boolean;
  error?: string;
  revision?: string;
  /** Why nothing was sent, when the caller needs to tell the operator what to fix. */
  reason?: 'no_connection' | 'not_configured' | 'empty' | 'unchanged';
}
