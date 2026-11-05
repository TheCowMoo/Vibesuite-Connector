import { createHash } from 'node:crypto';
import { ATTENDANCE_SEGMENTS, type AttendanceSegment, type AttendanceSegments, type SegmentPerson } from './attendanceSegments';

export type RosterShape = 'flat' | 'segments' | 'session';

const ROSTER_SHAPES: readonly string[] = ['flat', 'segments', 'session'];

/**
 * Accept only a shape we know; anything else (a missing field, a stale client) falls back.
 *
 * The fallback lets the PATCH route keep the format a connection already uses, while new
 * connections default to the flat call report.
 */
export function normalizeRosterShape(value: unknown, fallback: RosterShape = 'flat'): RosterShape {
  return typeof value === 'string' && ROSTER_SHAPES.includes(value) ? (value as RosterShape) : fallback;
}

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

/** One person in the flat call report, tagged with the result bucket they landed in. */
export interface FlatRosterPerson extends SegmentPerson {
  result: AttendanceSegment;
}

export interface FlatRosterPayload extends RosterBase {
  event: 'attendance.call';
  count: number;
  people: FlatRosterPerson[];
}

export type RosterPayload = SegmentRosterPayload | SessionRosterPayload | FlatRosterPayload;

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
    behavior: person.behavior,
  };
}

function rosterSegment(people: SegmentPerson[]): SegmentPerson[] {
  return people.map(rosterPerson);
}

/** Flatten the four buckets into one ordered list, keeping each person's result. */
function flatPeople(segments: AttendanceSegments): FlatRosterPerson[] {
  const people: FlatRosterPerson[] = [];
  for (const segment of ATTENDANCE_SEGMENTS) {
    for (const person of segments[segment]) {
      people.push({ ...rosterPerson(person), result: segment });
    }
  }
  return people;
}

/**
 * Build the external call-report payload(s).
 *
 * `flat` (the default for new connections) produces one request per call with everyone in one list
 * and a `result` on each person; `segments` produces one request per non-empty segment; `session`
 * produces a single snapshot of the four buckets. The revision excludes `generatedAt`, so the same
 * result yields the same revision across syncs and does not get resent.
 */
export function buildRosterPayloads(
  segments: AttendanceSegments,
  meta: RosterMeta,
  shape: RosterShape = 'flat',
): RosterPayload[] {
  const generatedAt = meta.generatedAt ?? new Date().toISOString();

  if (shape === 'flat') {
    const people = flatPeople(segments);
    // Nothing to report yet: the caller turns this into `reason: 'empty'` instead of a 0-person POST.
    if (!people.length) return [];
    const base = {
      event: 'attendance.call' as const,
      ...metaFields(meta),
      counts: segments.counts,
      count: people.length,
      people,
    };
    return [{ ...base, generatedAt, revision: stableRevision(base) }];
  }

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
