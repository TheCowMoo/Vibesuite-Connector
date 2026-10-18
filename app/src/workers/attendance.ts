import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { getSession, saveSession, type SessionRecord } from '../domain/sessionStore';
import { saveAttendance, getAttendance } from '../domain/attendanceStore';
import { buildReport, normalizeEmail, type AttendanceReport, type AttendancePerson } from '../domain/attendance';
import { getProvider } from '../video';
import { getList } from '../domain/listStore';
import { getInvite } from '../domain/inviteStore';
import { extractRecipients } from '../domain/invite';
import { getConnection } from '../domain/connectionStore';
import { lookupContactByEmail, addTags } from '../ghl/contacts';
import { postWebhook } from '../ghl/webhooks';
import { matchingRules, type ConditionContext } from '../domain/condition';
import { tryClaimAttendanceDispatch, releaseAttendanceDispatch } from '../domain/attendanceDispatch';

function buildContext(session: SessionRecord, p: AttendancePerson, report: AttendanceReport): ConditionContext {
  const ctx: ConditionContext = {};

  // Per attendee
  ctx.email = p.email ?? '';
  ctx.name = p.name ?? '';
  ctx.attendanceStatus = p.status;
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

  // Report rollups
  ctx.invitedCount = String(report.invitedCount);
  ctx.attendedCount = String(report.attendedCount);
  ctx.noShowCount = String(report.noShowCount);
  ctx.registrantCount = String(report.registrantCount ?? 0);
  ctx.absenteeCount = String((report.absentees || []).length);
  ctx.attendanceRate = String(Math.round((report.attendanceRate ?? 0) * 100));
  ctx.pollCount = String((report.polls || []).length);
  ctx.qaCount = String((report.qa || []).length);

  // Passthrough for anything else the provider reported.
  for (const k of Object.keys(stats)) {
    if (ctx[`stat_${k}`] === undefined) ctx[`stat_${k}`] = stats[k];
  }

  return ctx;
}

function buildPayload(session: SessionRecord, p: AttendancePerson, report: AttendanceReport): Record<string, unknown> {
  return {
    sessionId: session.id,
    provider: session.provider,
    sessionType: session.sessionType ?? 'meeting',
    title: session.title,
    email: p.email ?? null,
    name: p.name ?? null,
    status: p.status,
    joinedAt: p.joinedAt ?? null,
    leftAt: p.leftAt ?? null,
    durationSec: p.durationSec ?? null,
    attentivenessScore: p.attentivenessScore ?? null,
    isGuest: p.isGuest ?? null,
    registrantId: p.registrantId ?? null,
    invitedCount: report.invitedCount,
    attendedCount: report.attendedCount,
    noShowCount: report.noShowCount,
    registrantCount: report.registrantCount ?? 0,
    absenteeCount: (report.absentees || []).length,
    attendanceRate: Math.round((report.attendanceRate ?? 0) * 100),
    pollCount: (report.polls || []).length,
    qaCount: (report.qa || []).length,
    sessionStats: report.sessionStats ?? {},
    timestamp: new Date().toISOString(),
  };
}

async function resolveInvitedEmails(session: SessionRecord): Promise<string[]> {
  if (session.inviteId) {
    const invite = await getInvite(session.inviteId);
    if (invite && invite.listId) {
      const list = await getList(invite.listId);
      if (list && list.result) {
        return extractRecipients(list.result, invite.segments).emails;
      }
    }
  }
  return [];
}

export async function syncSession(sessionId: string): Promise<AttendanceReport> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('session not found');

  try {
    const provider = getProvider(session.provider);

    // Resolve the join link *before* the report fetch. `fetch()` reads the report API, which only
    // exists once the session has ended, so anything placed after it would never run for an
    // upcoming webinar — the one that actually needs its link. This also backfills sessions that
    // were created before we started storing one.
    if (!session.joinUrl && provider.resolveJoinUrl) {
      const resolved = await provider.resolveJoinUrl(session.externalId, session.sessionType ?? 'meeting');
      if (resolved) {
        session.joinUrl = resolved;
        await saveSession(session);
      }
    }

    const fetched = await provider.fetch(session.externalId, session.sessionType ?? 'meeting');

    const invited = await resolveInvitedEmails(session);
    const report = buildReport({
      sessionId,
      provider: session.provider,
      sessionTitle: session.title,
      sessionType: session.sessionType ?? 'meeting',
      invitedEmails: invited,
      attendees: fetched.attendees,
      absentees: fetched.absentees,
      registrantCount: fetched.registrants,
      sessionStats: fetched.sessionStats,
      polls: fetched.polls,
      qa: fetched.qa,
      minSeconds: env.ATTENDANCE_MIN_SECONDS,
    });

    await saveAttendance(report);

    const samplePerson: AttendancePerson =
      report.attended[0] ?? report.attendedNotInvited[0] ?? { email: 'person@example.com', name: 'Example', status: 'attended' };

    session.status = 'synced';
    session.lastSyncedAt = Date.now();
    session.error = undefined;
    session.samplePayload = buildPayload(session, samplePerson, report);
    await saveSession(session);

    inc('attendance_synced_total', { provider: session.provider });
    return report;
  } catch (err) {
    session.status = 'failed';
    session.error = (err as Error).message;
    await saveSession(session);
    inc('attendance_errors_total', { provider: session.provider });
    throw err;
  }
}

export async function dispatchSession(sessionId: string): Promise<{ dispatched: number }> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('session not found');
  const report = await getAttendance(sessionId);
  if (!report) throw new Error('no attendance report yet — run sync first');

  const conn = session.connectionId ? await getConnection(session.connectionId) : null;
  if (!conn) {
    logger.info({ sessionId }, 'no connection linked; skipping GHL dispatch');
    return { dispatched: 0 };
  }

  const mode = conn.attendanceDeliveryMode ?? 'both';
  let dispatched = 0;

  const entries: Array<{ person: AttendancePerson; status: string }> = [];
  report.attended.forEach((p) => entries.push({ person: p, status: p.status }));
  report.noShow.forEach((email) => entries.push({ person: { email, status: 'no_show' }, status: 'no_show' }));

  for (const { person, status } of entries) {
    const email = person.email ? normalizeEmail(person.email) : '';
    const fingerprint = `${email || person.name || 'anon'}:${status}`;
    const claimed = await tryClaimAttendanceDispatch(sessionId, fingerprint);
    if (!claimed) continue;

    try {
      const ctx = buildContext(session, person, report);

      if (mode === 'api' || mode === 'both') {
        if (email) {
          const contact = await lookupContactByEmail(conn, email);
          if (contact?.id) {
            const tag = status === 'no_show' ? env.GHL_TAG_NO_SHOW : env.GHL_TAG_ATTENDED;
            await addTags(conn, contact.id, [tag], `${sessionId}:${fingerprint}:tag`);
          }
        }
      }

      if (mode === 'webhook' || mode === 'both') {
        const rules = matchingRules(conn.attendanceRules, ctx);
        for (const rule of rules) {
          try {
            await postWebhook(rule.webhookUrl, buildPayload(session, person, report));
            logger.info({ sessionId, ruleId: rule.id, email }, 'attendance rule webhook fired');
          } catch (err) {
            logger.error({ sessionId, ruleId: rule.id, err: (err as Error).message }, 'attendance rule webhook failed');
          }
        }
      }

      dispatched += 1;
      inc('attendance_dispatched_total', { status });
    } catch (err) {
      await releaseAttendanceDispatch(sessionId, fingerprint);
      logger.error({ sessionId, email, err: (err as Error).message }, 'attendance dispatch failed');
    }
  }

  return { dispatched };
}

