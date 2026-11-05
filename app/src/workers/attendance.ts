import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { getSession, saveSession, type SessionRecord } from '../domain/sessionStore';
import { saveAttendance, getAttendance } from '../domain/attendanceStore';
import { buildReport, normalizeEmail, type AttendanceReport, type InvitedSource } from '../domain/attendance';
import { getProvider } from '../video';
import { getList } from '../domain/listStore';
import { getInvite } from '../domain/inviteStore';
import { extractRecipients } from '../domain/invite';
import { getConnection } from '../domain/connectionStore';
import { getRecipients, listCampaigns } from '../domain/campaignStore';
import { isCalendarResource, missingAudienceNote, pickInvitedEmails } from '../domain/sessionAudience';
import { stateStore } from '../domain/stateStore';
import { REPORT_RETRY_WINDOW_MS, syncOutcome } from '../domain/sessionSync';
import { lookupContactByEmail, addTags, updateCustomField } from '../ghl/contacts';
import { postWebhook } from '../ghl/webhooks';
import { matchingRules } from '../domain/condition';
import { buildAttendanceContext } from '../domain/attendanceContext';
import { tryClaimAttendanceDispatch, releaseAttendanceDispatch } from '../domain/attendanceDispatch';
import { forEachLimit, withRetry } from '../domain/concurrency';
import { applyWorkflowRules, autoAssignAiWorkflows } from '../domain/attendanceWorkflows';
import {
  buildAttendanceSegments,
  segmentEntries,
  segmentTag,
  type AttendanceSegment,
  type AttendanceSegments,
  type SegmentPerson,
} from '../domain/attendanceSegments';
import {
  buildRosterPayloads,
  stableRevision,
  type RosterDeliveryResult,
  type RosterPayload,
} from '../domain/attendanceRoster';
import type { AttendanceRosterSettings, StoredConnection } from '../domain/connection';
import axios from 'axios';

function buildPayload(
  session: SessionRecord,
  p: SegmentPerson,
  report: AttendanceReport,
  segment: AttendanceSegment,
  segments: AttendanceSegments,
): Record<string, unknown> {
  return {
    event: 'attendance.result',
    sessionId: session.id,
    provider: session.provider,
    sessionType: session.sessionType ?? 'meeting',
    title: session.title,
    segment,
    invited: segment !== 'not_invited',
    invitedSource: report.invitedSource ?? 'none',
    email: p.email ?? null,
    name: p.name ?? null,
    status: p.status,
    minutes: p.minutes ?? null,
    joinedAt: p.joinedAt ?? null,
    leftAt: p.leftAt ?? null,
    durationSec: p.durationSec ?? null,
    attentivenessScore: p.attentivenessScore ?? null,
    isGuest: p.isGuest ?? null,
    registrantId: p.registrantId ?? null,
    invitedCount: report.invitedCount,
    attendedCount: report.attendedCount,
    attendedFullCount: segments.counts.attended,
    partialCount: segments.counts.partial,
    noShowCount: report.noShowCount,
    notInvitedCount: segments.counts.notInvited,
    registrantCount: report.registrantCount ?? 0,
    absenteeCount: (report.absentees || []).length,
    attendanceRate: Math.round((report.attendanceRate ?? 0) * 100),
    segmentCounts: segments.counts,
    pollCount: report.pollQuestionCount ?? 0,
    pollRespondentCount: report.pollRespondentCount ?? 0,
    pollAnswerCount: report.pollAnswerCount ?? 0,
    qaCount: (report.qa || []).length,
    pollAnswers: p.behavior?.pollAnswers ?? [],
    qa: p.behavior?.qa ?? [],
    registrationAnswers: p.behavior?.registrationAnswers ?? [],
    behavior: p.behavior ?? null,
    sessionStats: report.sessionStats ?? {},
    timestamp: new Date().toISOString(),
  };
}

/** Campaigns whose audience is this call: their frozen rows are the exact invited set. */
async function campaignInvitedEmails(session: SessionRecord): Promise<{ emails: string[]; campaigns: number }> {
  const campaigns = (await listCampaigns()).filter((c) => c.sessionId === session.id);
  if (!campaigns.length) return { emails: [], campaigns: 0 };

  const emails: string[] = [];
  for (const camp of campaigns) {
    const recipients = await getRecipients(camp.id);
    // Only rows that actually went out: a pending or failed recipient was never invited, and
    // counting them would invent a no-show.
    for (const r of recipients) if (r.status === 'sent') emails.push(r.email);
  }
  return { emails, campaigns: campaigns.length };
}

async function inviteInvitedEmails(session: SessionRecord): Promise<string[]> {
  if (!session.inviteId) return [];
  const invite = await getInvite(session.inviteId);
  if (!invite) return [];

  // Exact audience: the calendar events this invitation created. Their attendee lists are already
  // stored by the calendar sync, so no Google call is needed — and people whose email never went
  // out are excluded, instead of being counted as no-shows.
  const eventIds = (invite.batches ?? []).map((b) => b.eventId).filter((id): id is string => !!id);
  const connectionIds = Array.from(
    new Set(
      [invite.connectionId, ...(invite.senders ?? []).map((s) => s.connectionId)].filter(
        (id): id is string => !!id,
      ),
    ),
  );

  if (eventIds.length && connectionIds.length) {
    const emails: string[] = [];
    for (const connectionId of connectionIds) {
      const states = await stateStore.getStates(connectionId);
      for (const eventId of eventIds) {
        const attendees = states.get(eventId);
        if (!attendees) continue;
        for (const email of Object.keys(attendees)) {
          if (!isCalendarResource(email)) emails.push(email);
        }
      }
    }
    if (emails.length) return emails;
  }

  // The invite event has not synced yet (or predates event batches): fall back to the list groups.
  if (!invite.listId) return [];
  const list = await getList(invite.listId);
  return list && list.result ? extractRecipients(list.result, invite.segments).emails : [];
}

async function listInvitedEmails(session: SessionRecord): Promise<string[]> {
  if (!session.listId) return [];
  const list = await getList(session.listId);
  return list && list.result ? extractRecipients(list.result, []).emails : [];
}

/**
 * Who was invited to this call.
 *
 * Campaigns that link the call win, because their recipient rows are exactly what was emailed.
 * Sessions created from the Invitations tab fall back to that invitation's list, and a call with a
 * list attached uses it whole. This used to read `session.inviteId` only, which left every
 * campaign-linked call with an empty invited set — Zoom's participants then all landed in
 * `attendedNotInvited` and the panel showed a flat zero.
 */
async function resolveInvitedEmails(
  session: SessionRecord,
): Promise<{ emails: string[]; linkedCampaigns: number; source: InvitedSource }> {
  const campaigns = await campaignInvitedEmails(session);
  if (campaigns.emails.length) {
    return {
      emails: pickInvitedEmails({ campaignEmails: campaigns.emails, inviteEmails: [], listEmails: [] }).emails,
      linkedCampaigns: campaigns.campaigns,
      source: 'campaign',
    };
  }

  const inviteEmails = await inviteInvitedEmails(session);
  if (inviteEmails.length) {
    return {
      emails: pickInvitedEmails({ campaignEmails: [], inviteEmails, listEmails: [] }).emails,
      linkedCampaigns: campaigns.campaigns,
      source: 'invitation',
    };
  }

  const listEmails = await listInvitedEmails(session);
  const picked = pickInvitedEmails({ campaignEmails: [], inviteEmails: [], listEmails });
  return {
    emails: picked.emails,
    linkedCampaigns: campaigns.campaigns,
    source: picked.emails.length ? 'list' : 'none',
  };
}

export async function syncSession(sessionId: string): Promise<AttendanceReport> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('session not found');

  try {
    const provider = getProvider(session.provider);
    // Which tenant/mailbox this session belongs to — with per-connection Zoom auth this selects the
    // right host token instead of the account-wide one.
    const authCtx = { connectionId: session.connectionId, zoomUserId: session.zoomUserId };

    // Resolve the join link *before* the report fetch. `fetch()` reads the report API, which only
    // exists once the session has ended, so anything placed after it would never run for an
    // upcoming webinar — the one that actually needs its link. This also backfills sessions that
    // were created before we started storing one.
    if (!session.joinUrl && provider.resolveJoinUrl) {
      const resolved = await provider.resolveJoinUrl(session.externalId, session.sessionType ?? 'meeting', authCtx);
      if (resolved) {
        session.joinUrl = resolved;
        await saveSession(session);
      }
    }

    const fetched = await provider.fetch(session.externalId, session.sessionType ?? 'meeting', authCtx);

    // Apply what the provider had to correct to make the call readable (a pasted link, the wrong
    // call type, another host). Persisting it means the next sync starts from the right place.
    const correction = fetched.correction;
    if (correction) {
      if (correction.externalId) session.externalId = correction.externalId;
      if (correction.sessionType) session.sessionType = correction.sessionType;
      if (correction.zoomUserId) session.zoomUserId = correction.zoomUserId;
    }
    if (fetched.diagnostics) session.syncDiagnostics = fetched.diagnostics;

    const invited = await resolveInvitedEmails(session);
    const report = buildReport({
      sessionId,
      provider: session.provider,
      sessionTitle: session.title,
      sessionType: session.sessionType ?? 'meeting',
      invitedSource: invited.source,
      invitedEmails: invited.emails,
      attendees: fetched.attendees,
      absentees: fetched.absentees,
      registrantCount: fetched.registrants,
      sessionStats: fetched.sessionStats,
      polls: fetched.polls,
      qa: fetched.qa,
      registrantRows: fetched.registrantRows,
      sessionStart: session.startTime,
      sessionEnd: session.endTime,
      minSeconds: env.ATTENDANCE_MIN_SECONDS,
    });

    const notes = [...(fetched.notes ?? [])];
    const audienceNote = missingAudienceNote({
      invitedCount: report.invitedCount,
      seen: report.attended.length + report.attendedNotInvited.length,
      linkedCampaigns: invited.linkedCampaigns,
    });
    if (audienceNote) notes.push(audienceNote);

    const reportReady = fetched.reportReady !== false;
    const outcome = syncOutcome({ reportReady, endTime: session.endTime, now: Date.now() });
    if (outcome === 'synced' && !reportReady) {
      notes.push(
        `Zoom still has no report for this call after ${Math.round(REPORT_RETRY_WINDOW_MS / 3600000)} hours. Check the call type (meeting or webinar), the ID and the selected Zoom host.`,
      );
    }

    // Only a real report is stored. An empty placeholder would tell campaign stats that everyone who
    // said yes was a no-show while Zoom is still preparing the data.
    if (outcome === 'synced') {
      await saveAttendance(report);
      const sampleSegments = buildAttendanceSegments(report);
      const sample = pickSampleSegment(sampleSegments);
      session.samplePayload = buildPayload(session, sample.person, report, sample.segment, sampleSegments);
    }

    session.status = outcome;
    session.lastSyncedAt = Date.now();
    session.error = undefined;
    // Keep the provider's explanations (e.g. no report access) so an empty section is not a mystery.
    session.warnings = notes.length ? notes : undefined;
    await saveSession(session);

    inc(outcome === 'synced' ? 'attendance_synced_total' : 'attendance_pending_total', { provider: session.provider });
    return report;
  } catch (err) {
    session.status = 'failed';
    session.error = (err as Error).message;
    await saveSession(session);
    inc('attendance_errors_total', { provider: session.provider });
    throw err;
  }
}

export interface DispatchOptions {
  /** Skip the per-person pass and only deliver the call report. */
  rosterOnly?: boolean;
  /** Resend the call report even when its revision has not changed. */
  forceRoster?: boolean;
}

export interface DispatchResult {
  dispatched: number;
  failed: number;
  segments: AttendanceSegments['counts'];
  roster: RosterDeliveryResult;
  workflows: { applied: number; skipped: number; failed: number };
  workflowError?: string;
}

/**
 * Deliver a session's attendance.
 *
 * Two channels: per-person (GHL tag/custom field + condition webhooks) and an optional roster
 * webhook carrying a whole segment. Walk-ins are dispatched too, and never counted as no-shows.
 */
export async function dispatchSession(
  sessionId: string,
  opts: DispatchOptions = {},
): Promise<DispatchResult> {
  const session = await getSession(sessionId);
  if (!session) throw new Error('session not found');
  const report = await getAttendance(sessionId);
  if (!report) throw new Error('no attendance report yet — run sync first');

  const segments = buildAttendanceSegments(report);
  const conn = session.connectionId ? await getConnection(session.connectionId) : null;
  let dispatched = 0;
  let failed = 0;

  if (opts.rosterOnly) {
    const roster = await deliverRoster(session, report, segments, conn, opts.forceRoster === true);
    return {
      dispatched: 0,
      failed: 0,
      segments: segments.counts,
      roster,
      workflows: { applied: 0, skipped: 0, failed: 0 },
    };
  }

  if (conn) {
    const mode = conn.attendanceDeliveryMode ?? 'both';

    await forEachLimit(
      segmentEntries(segments),
      env.ATTENDANCE_DISPATCH_CONCURRENCY,
      async ({ segment, person }) => {
        const email = person.email ? normalizeEmail(person.email) : '';
        // Walk-ins are new, so they get their own key. Matched outcomes keep the pre-segment key:
        // deploying this must not replay every past attendee into GHL a second time.
        const identity = email || person.name || person.participantId || person.registrantId || 'anon';
        const fingerprint =
          segment === 'not_invited' ? `${identity}:${segment}:${person.status}` : `${identity}:${person.status}`;
        const claimed = await tryClaimAttendanceDispatch(sessionId, fingerprint);
        if (!claimed) return;

        try {
          // Retrying the whole entry is safe: tags and custom fields are idempotent, and webhook
          // failures are caught per rule below rather than thrown.
          await withRetry(
            async () => {
              const ctx = buildAttendanceContext(session, person, report, segment, segments);

              if (mode === 'api' || mode === 'both') {
                if (email) {
                  const contact = await lookupContactByEmail(conn, email);
                  if (contact?.id) {
                    const tag = segmentTag(segment, conn.attendanceTags, {
                      attended: env.GHL_TAG_ATTENDED,
                      noShow: env.GHL_TAG_NO_SHOW,
                      notInvited: env.GHL_TAG_NOT_INVITED,
                    });
                    await addTags(conn, contact.id, [tag], `${sessionId}:${fingerprint}:tag`);
                    if (conn.attendanceCustomFieldId) {
                      await updateCustomField(
                        conn,
                        contact.id,
                        conn.attendanceCustomFieldId,
                        segment,
                        `${sessionId}:${fingerprint}:segment`,
                      );
                    }
                  }
                }
              }

              if (mode === 'webhook' || mode === 'both') {
                const rules = matchingRules(conn.attendanceRules, ctx);
                for (const rule of rules) {
                  try {
                    await postWebhook(rule.webhookUrl, buildPayload(session, person, report, segment, segments));
                    logger.info({ sessionId, ruleId: rule.id, email, segment }, 'attendance rule webhook fired');
                  } catch (err) {
                    logger.error({ sessionId, ruleId: rule.id, err: (err as Error).message }, 'attendance rule webhook failed');
                  }
                }
              }
            },
            { attempts: 3, baseDelayMs: 400 },
          );

          dispatched += 1;
          inc('attendance_dispatched_total', { status: person.status, segment });
        } catch (err) {
          failed += 1;
          await releaseAttendanceDispatch(sessionId, fingerprint);
          logger.error({ sessionId, email, segment, err: (err as Error).message }, 'attendance dispatch failed');
        }
      },
    );
  } else {
    logger.info({ sessionId }, 'no connection linked; skipping GHL contact actions');
  }

  let workflows = { applied: 0, skipped: 0, failed: 0 };
  let workflowError: string | undefined;
  if (conn) {
    try {
      const ruleResult = await applyWorkflowRules(session, report, segments, conn);
      workflows.applied += ruleResult.applied;
      workflows.skipped += ruleResult.skipped;
      workflows.failed += ruleResult.failed;
    } catch (err) {
      workflowError = (err as Error).message;
      logger.error({ sessionId, err: workflowError }, 'attendance workflow rules failed');
    }

    try {
      const aiResult = await autoAssignAiWorkflows(sessionId, conn);
      workflows.applied += aiResult.applied;
      workflows.skipped += aiResult.skipped;
      workflows.failed += aiResult.failed;
    } catch (err) {
      workflowError = (err as Error).message;
      logger.error({ sessionId, err: workflowError }, 'attendance AI workflow routing failed');
    }
  }

  const roster = await deliverRoster(session, report, segments, conn, opts.forceRoster === true);
  const latest = await getSession(sessionId);
  if (latest) {
    latest.lastDispatchedAt = Date.now();
    await saveSession(latest);
  }
  return { dispatched, failed, segments: segments.counts, roster, workflows, workflowError };
}

/** Pick a representative person for the sample payload, preferring a matched attendee. */
function pickSampleSegment(segments: AttendanceSegments): { person: SegmentPerson; segment: AttendanceSegment } {
  if (segments.attended.length) return { person: segments.attended[0], segment: 'attended' };
  if (segments.partial.length) return { person: segments.partial[0], segment: 'partial' };
  if (segments.not_invited.length) return { person: segments.not_invited[0], segment: 'not_invited' };
  return {
    person: { email: 'person@example.com', name: 'Example', status: 'attended' },
    segment: 'attended',
  };
}

/** POST one call-report payload, with a short retry for transient failures. */
async function postRosterPayload(
  settings: AttendanceRosterSettings,
  token: string | undefined,
  payload: RosterPayload,
): Promise<void> {
  if (!settings.url) throw new Error('call report webhook URL missing');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Vibesuite-Event': payload.event,
    'X-Vibesuite-Revision': payload.revision,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let lastError: { response?: { status?: number }; message?: string } | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await axios.post(settings.url, payload, { headers, timeout: 20000 });
      return;
    } catch (err) {
      lastError = err as { response?: { status?: number }; message?: string };
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  const status = lastError?.response?.status;
  throw new Error(status ? `call report webhook returned ${status}` : lastError?.message || 'call report webhook failed');
}

/**
 * Send the call report to the configured URL, unless the same content was already delivered.
 *
 * The revision covers the people and counts but not the generation time, so a re-sync with no new
 * data is a no-op; a corrected report produces a new revision the consumer can upsert.
 */
async function deliverRoster(
  session: SessionRecord,
  report: AttendanceReport,
  segments: AttendanceSegments,
  conn: StoredConnection | null,
  force: boolean,
): Promise<RosterDeliveryResult> {
  const settings = conn?.attendanceRoster;
  if (!conn) return { sent: 0, skipped: true, reason: 'no_connection' };
  if (!settings?.url) return { sent: 0, skipped: true, reason: 'not_configured' };

  const payloads = buildRosterPayloads(
    segments,
    {
      sessionId: session.id,
      sessionTitle: session.title,
      sessionType: session.sessionType ?? 'meeting',
      provider: session.provider,
      invitedSource: report.invitedSource,
    },
    settings.shape ?? 'flat',
  );
  if (!payloads.length) return { sent: 0, skipped: true, reason: 'empty' };

  const revision = stableRevision(payloads.map((p) => p.revision));
  if (!force && session.rosterRevision === revision) {
    logger.info({ sessionId: session.id }, 'attendance call report unchanged; skipping');
    return { sent: 0, skipped: true, revision, reason: 'unchanged' };
  }

  let sent = 0;
  try {
    for (const payload of payloads) {
      await postRosterPayload(settings, conn.attendanceRosterToken, payload);
      sent += 1;
    }
    session.rosterRevision = revision;
    session.rosterSentAt = Date.now();
    session.rosterError = undefined;
    const latest = (await getSession(session.id)) ?? session;
    latest.rosterRevision = revision;
    latest.rosterSentAt = session.rosterSentAt;
    latest.rosterError = undefined;
    await saveSession(latest);
    inc('attendance_roster_sent_total', {}, sent);
    return { sent, skipped: false, revision };
  } catch (err) {
    const message = (err as Error).message;
    session.rosterError = message;
    const latest = (await getSession(session.id)) ?? session;
    latest.rosterError = message;
    await saveSession(latest);
    inc('attendance_roster_errors_total');
    logger.error({ sessionId: session.id, err: message }, 'attendance call report delivery failed');
    return { sent, skipped: false, error: message, revision };
  }
}

