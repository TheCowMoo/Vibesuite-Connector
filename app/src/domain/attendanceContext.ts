import type { ConditionContext } from './condition';
import type { AttendanceReport } from './attendance';
import type { AttendanceSegment, AttendanceSegments, SegmentPerson } from './attendanceSegments';
import type { SessionRecord } from './sessionStore';

/**
 * The flat, string-valued context every rule is evaluated against.
 *
 * Kept pure and outside the worker so the same values feed deterministic workflow rules, the
 * existing webhook rules and tests. Per-person poll/Q&A/registration fields live under their own
 * names; session-wide rollups keep the original `pollCount` / `qaCount` names.
 */
export function buildAttendanceContext(
  session: SessionRecord,
  p: SegmentPerson,
  report: AttendanceReport,
  segment: AttendanceSegment,
  segments: AttendanceSegments,
): ConditionContext {
  const ctx: ConditionContext = {};
  const b = p.behavior;

  // Per attendee
  ctx.email = p.email ?? '';
  ctx.name = p.name ?? '';
  ctx.attendanceStatus = p.status;
  ctx.segment = segment;
  ctx.invited = segment === 'not_invited' ? 'false' : 'true';
  ctx.attendanceMinutes = p.durationSec !== undefined ? String(Math.round(p.durationSec / 60)) : '';
  ctx.durationSec = p.durationSec !== undefined ? String(p.durationSec) : '';
  ctx.joinedAt = p.joinedAt ?? '';
  ctx.leftAt = p.leftAt ?? '';
  ctx.attentivenessScore = p.attentivenessScore !== undefined ? String(p.attentivenessScore) : '';
  ctx.isGuest = p.isGuest === undefined ? '' : String(p.isGuest);
  ctx.registrantId = p.registrantId ?? '';
  ctx.userId = p.userId ?? '';
  ctx.participantId = p.participantId ?? '';
  ctx.customerKey = p.customerKey ?? '';

  // Per attendee — Zoom behaviour
  ctx.pollQuestionCount = String(b?.pollQuestionCount ?? report.pollQuestionCount ?? 0);
  ctx.pollAnsweredCount = String(b?.pollAnsweredCount ?? 0);
  ctx.pollAnswerCount = String(b?.pollAnswers.length ?? 0);
  ctx.pollAnsweredAll =
    b && b.pollQuestionCount > 0 ? String(b.pollAnsweredCount >= b.pollQuestionCount) : 'false';
  ctx.pollAnswerText = b?.pollAnswerText ?? '';
  ctx.qaAskedCount = String(b?.qaAskedCount ?? 0);
  ctx.qaAnsweredCount = String(b?.qaAnsweredCount ?? 0);
  ctx.qaQuestionText = b?.qaQuestionText ?? '';
  ctx.registrationAnswerCount = String(b?.registrationAnswerCount ?? 0);
  ctx.registrationAnswerText = b?.registrationAnswerText ?? '';
  ctx.joinedLateMinutes = b?.joinedLateMinutes !== undefined ? String(b.joinedLateMinutes) : '';
  ctx.leftEarlyMinutes = b?.leftEarlyMinutes !== undefined ? String(b.leftEarlyMinutes) : '';
  ctx.attendedPortionPct = b?.attendedPortionPct !== undefined ? String(b.attendedPortionPct) : '';
  ctx.zoomDevice = b?.device ?? '';
  ctx.zoomLocation = b?.location ?? '';
  ctx.zoomNetworkType = b?.networkType ?? '';
  ctx.zoomMicrophone = b?.microphone ?? '';
  ctx.zoomCamera = b?.camera ?? '';
  ctx.zoomConnectionType = b?.connectionType ?? '';
  ctx.zoomShareDesktop = b?.shareDesktop === undefined ? '' : String(b.shareDesktop);
  ctx.zoomShareApplication = b?.shareApplication === undefined ? '' : String(b.shareApplication);

  // Session
  ctx.provider = session.provider;
  ctx.sessionId = session.id;
  ctx.sessionType = session.sessionType ?? 'meeting';
  ctx.sessionTitle = session.title;
  ctx.sessionStart = session.startTime;
  ctx.sessionEnd = session.endTime;

  const stats = report.sessionStats ?? {};
  ctx.sessionDurationMin = stats.duration ?? '';
  ctx.sessionTotalMinutes = stats.total_minutes ?? '';
  ctx.sessionParticipantsCount = stats.participants_count ?? '';
  ctx.sessionHostEmail = stats.host_email ?? '';
  ctx.sessionDept = stats.dept ?? '';

  // Report rollups — the original names keep their meaning, the segment counts are additive.
  ctx.invitedCount = String(report.invitedCount);
  ctx.attendedCount = String(report.attendedCount);
  ctx.noShowCount = String(report.noShowCount);
  ctx.registrantCount = String(report.registrantCount ?? 0);
  ctx.absenteeCount = String((report.absentees || []).length);
  ctx.attendanceRate = String(Math.round((report.attendanceRate ?? 0) * 100));
  ctx.pollCount = String(report.pollQuestionCount ?? 0);
  ctx.pollRespondentCount = String(report.pollRespondentCount ?? 0);
  ctx.qaCount = String((report.qa || []).length);
  ctx.attendedFullCount = String(segments.counts.attended);
  ctx.partialCount = String(segments.counts.partial);
  ctx.notInvitedCount = String(segments.counts.notInvited);
  ctx.invitedSource = report.invitedSource ?? 'none';

  // Passthrough for anything else the provider reported.
  for (const k of Object.keys(stats)) {
    if (ctx[`stat_${k}`] === undefined) ctx[`stat_${k}`] = stats[k];
  }

  return ctx;
}
