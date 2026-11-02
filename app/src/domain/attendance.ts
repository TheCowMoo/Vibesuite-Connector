import type { AttendeeRecord, PollResult, QaEntry, RegistrantRecord } from '../video/types';
import { buildZoomBehavior, behaviorFor, type PollQuestionSummary, type ZoomBehavior } from './zoomBehavior';

export type AttendanceStatus = 'attended' | 'no_show' | 'partial';

/** Where the invited set for a call came from. */
export type InvitedSource = 'campaign' | 'invitation' | 'list' | 'none';

export interface AttendancePerson {
  email?: string;
  name?: string;
  status: AttendanceStatus;
  joinedAt?: string;
  leftAt?: string;
  durationSec?: number;
  attentivenessScore?: number;
  isGuest?: boolean;
  registrantId?: string;
  userId?: string;
  participantId?: string;
  customerKey?: string;
  raw?: Record<string, unknown>;
  /** Poll answers, Q&A, registration answers and participation stats. */
  behavior?: ZoomBehavior;
}

export interface AttendanceReport {
  sessionId: string;
  provider: string;
  sessionTitle?: string;
  sessionType?: string;
  /** Where the invited set came from — carried into payloads so a no-show is explainable. */
  invitedSource?: InvitedSource;
  invitedCount: number;
  attendedCount: number;
  noShowCount: number;
  attended: AttendancePerson[];
  noShow: string[];
  attendedNotInvited: AttendancePerson[];
  absentees: string[];
  registrantCount: number;
  attendanceRate: number;
  sessionStats: Record<string, string>;
  polls: PollResult[];
  qa: QaEntry[];
  /** Distinct poll questions, respondents and total answers (not the old row count). */
  pollQuestionCount: number;
  pollRespondentCount: number;
  pollAnswerCount: number;
  /** Per-question answer counts, ready for the session detail. */
  pollSummary?: PollQuestionSummary[];
  /** Full registrant rows, including custom registration answers. */
  registrantDetails?: RegistrantRecord[];
  sessionStart?: string;
  sessionEnd?: string;
  generatedAt: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface BuildReportParams {
  sessionId: string;
  provider: string;
  sessionTitle?: string;
  sessionType?: string;
  invitedSource?: InvitedSource;
  invitedEmails: string[];
  attendees: AttendeeRecord[];
  absentees?: string[];
  registrantCount?: number;
  sessionStats?: Record<string, string>;
  polls?: PollResult[];
  qa?: QaEntry[];
  registrantRows?: RegistrantRecord[];
  sessionStart?: string;
  sessionEnd?: string;
  minSeconds?: number;
}

export function buildReport(params: BuildReportParams): AttendanceReport {
  const { sessionId, provider, invitedEmails } = params;
  const minSeconds = params.minSeconds ?? 0;

  const invited = new Set(invitedEmails.map(normalizeEmail).filter(Boolean));

  const byEmail = new Map<string, AttendeeRecord>();
  const noEmailAttendees: AttendeeRecord[] = [];
  for (const a of params.attendees) {
    const email = a.email ? normalizeEmail(a.email) : undefined;
    if (email) {
      const prev = byEmail.get(email);
      if (prev) prev.durationSec = (prev.durationSec ?? 0) + (a.durationSec ?? 0);
      else byEmail.set(email, { ...a, email });
    } else if (a.name && a.name.trim()) {
      noEmailAttendees.push(a);
    }
  }

  const behaviorIndex = buildZoomBehavior({
    people: [...byEmail.values(), ...noEmailAttendees],
    polls: params.polls ?? [],
    qa: params.qa ?? [],
    registrants: params.registrantRows ?? [],
    sessionStart: params.sessionStart,
    sessionEnd: params.sessionEnd,
  });

  const toPerson = (email: string | undefined, rec: AttendeeRecord): AttendancePerson => ({
    email,
    name: rec.name,
    status: (rec.durationSec ?? 0) >= minSeconds ? 'attended' : 'partial',
    joinedAt: rec.joinedAt,
    leftAt: rec.leftAt,
    durationSec: rec.durationSec,
    attentivenessScore: rec.attentivenessScore,
    isGuest: rec.isGuest,
    registrantId: rec.registrantId,
    userId: rec.userId,
    participantId: rec.participantId,
    customerKey: rec.customerKey,
    raw: rec.raw,
    behavior: behaviorFor(behaviorIndex, email, rec.name),
  });

  const attended: AttendancePerson[] = [];
  const attendedNotInvited: AttendancePerson[] = [];
  const matched = new Set<string>();

  for (const [email, rec] of byEmail) {
    matched.add(email);
    const p = toPerson(email, rec);
    if (invited.has(email)) attended.push(p);
    else attendedNotInvited.push(p);
  }

  for (const rec of noEmailAttendees) {
    attendedNotInvited.push(toPerson(undefined, rec));
  }

  const noShow: string[] = [];
  for (const email of invited) {
    if (!matched.has(email)) noShow.push(email);
  }

  const invitedCount = invited.size;
  const attendedCount = attended.length;

  return {
    sessionId,
    provider,
    sessionTitle: params.sessionTitle,
    sessionType: params.sessionType,
    invitedSource: params.invitedSource,
    invitedCount,
    attendedCount,
    noShowCount: noShow.length,
    attended,
    noShow,
    attendedNotInvited,
    absentees: params.absentees ?? [],
    registrantCount: params.registrantCount ?? 0,
    attendanceRate: invitedCount > 0 ? attendedCount / invitedCount : 0,
    sessionStats: params.sessionStats ?? {},
    polls: params.polls ?? [],
    qa: params.qa ?? [],
    pollQuestionCount: behaviorIndex.pollQuestions.length,
    pollRespondentCount: behaviorIndex.pollRespondentCount,
    pollAnswerCount: behaviorIndex.pollAnswerCount,
    pollSummary: behaviorIndex.pollSummary,
    registrantDetails: params.registrantRows ?? [],
    sessionStart: params.sessionStart,
    sessionEnd: params.sessionEnd,
    generatedAt: Date.now(),
  };
}
