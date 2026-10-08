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

function buildContext(session: SessionRecord, p: AttendancePerson): ConditionContext {
  return {
    email: p.email ?? '',
    attendanceStatus: p.status,
    attendanceMinutes: p.durationSec !== undefined ? String(Math.round(p.durationSec / 60)) : '',
    provider: session.provider,
    sessionTitle: session.title,
    sessionId: session.id,
    joinedAt: p.joinedAt ?? '',
    leftAt: p.leftAt ?? '',
  };
}

function buildPayload(session: SessionRecord, p: AttendancePerson, report: AttendanceReport): Record<string, unknown> {
  return {
    sessionId: session.id,
    provider: session.provider,
    title: session.title,
    email: p.email ?? null,
    name: p.name ?? null,
    status: p.status,
    joinedAt: p.joinedAt ?? null,
    leftAt: p.leftAt ?? null,
    durationSec: p.durationSec ?? null,
    invitedCount: report.invitedCount,
    attendedCount: report.attendedCount,
    noShowCount: report.noShowCount,
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
    const attendees = await provider.listAttendees(session.externalId);

    const invited = await resolveInvitedEmails(session);
    const report = buildReport({
      sessionId,
      provider: session.provider,
      invitedEmails: invited,
      attendees,
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
      const ctx = buildContext(session, person);

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

