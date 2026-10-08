import type { AttendeeRecord } from '../video/types';

export type AttendanceStatus = 'attended' | 'no_show' | 'partial';

export interface AttendancePerson {
  email?: string;
  name?: string;
  status: AttendanceStatus;
  joinedAt?: string;
  leftAt?: string;
  durationSec?: number;
}

export interface AttendanceReport {
  sessionId: string;
  provider: string;
  invitedCount: number;
  attendedCount: number;
  noShowCount: number;
  attended: AttendancePerson[];
  noShow: string[];
  attendedNotInvited: AttendancePerson[];
  generatedAt: number;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface BuildReportParams {
  sessionId: string;
  provider: string;
  invitedEmails: string[];
  attendees: AttendeeRecord[];
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

  const toPerson = (email: string | undefined, rec: AttendeeRecord): AttendancePerson => ({
    email,
    name: rec.name,
    status: (rec.durationSec ?? 0) >= minSeconds ? 'attended' : 'partial',
    joinedAt: rec.joinedAt,
    leftAt: rec.leftAt,
    durationSec: rec.durationSec,
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

  return {
    sessionId,
    provider,
    invitedCount: invited.size,
    attendedCount: attended.length,
    noShowCount: noShow.length,
    attended,
    noShow,
    attendedNotInvited,
    generatedAt: Date.now(),
  };
}
