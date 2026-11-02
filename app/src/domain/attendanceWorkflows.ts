import { createHash } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { generateJson } from '../lib/ai';
import { getAiSettings } from './aiSettings';
import { getAttendance } from './attendanceStore';
import { getConnection } from './connectionStore';
import {
  getSession,
  saveSession,
  type SessionRecord,
  type WorkflowAssignmentRecord,
  type WorkflowAssignmentSource,
  type WorkflowPreview,
  type WorkflowPreviewAssignment,
} from './sessionStore';
import {
  buildAttendanceSegments,
  segmentEntries,
  type AttendanceSegments,
  type SegmentPerson,
} from './attendanceSegments';
import type { AttendanceReport } from './attendance';
import type { StoredConnection, WorkflowTarget } from './connection';
import { buildAttendanceContext } from './attendanceContext';
import {
  buildWorkflowAiPrompt,
  firstMatchingWorkflowRule,
  validateAiWorkflowResponse,
  type AiAttendeeBehavior,
} from './workflowRules';
import { addContactToWorkflow, lookupContactByEmail } from '../ghl/contacts';
import { forEachLimit } from './concurrency';
import {
  clearChosenWorkflow,
  getChosenWorkflow,
  releaseWorkflowLock,
  saveChosenWorkflow,
  tryClaimWorkflowLock,
} from './attendanceWorkflowStore';

const AI_SYSTEM_PROMPT = [
  'You route video-call attendees into GoHighLevel workflows.',
  'Choose at most one workflow from the allowed list for each attendee.',
  'Use only the workflowId values in the allowed list. Never invent an id.',
  'Base the decision only on the anonymous behavior and the workflow criteria provided.',
  'If no workflow clearly fits, return workflowId null instead of guessing.',
  'Do not infer sensitive traits. Return JSON only.',
].join(' ');

const PREVIEW_CACHE_MS = 10 * 60 * 1000;

export class WorkflowRoutingError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'WorkflowRoutingError';
  }
}

interface WorkflowContext {
  session: SessionRecord;
  report: AttendanceReport;
  segments: AttendanceSegments;
  conn: StoredConnection;
}

async function loadWorkflowContext(sessionId: string): Promise<WorkflowContext> {
  const session = await getSession(sessionId);
  if (!session) throw new WorkflowRoutingError('session not found', 404);
  if (!session.connectionId) throw new WorkflowRoutingError('this session has no connection', 400);

  const [report, conn] = await Promise.all([getAttendance(sessionId), getConnection(session.connectionId)]);
  if (!report) throw new WorkflowRoutingError('sync the attendance report before routing workflows', 409);
  if (!conn) throw new WorkflowRoutingError('connection not found', 404);

  return { session, report, segments: buildAttendanceSegments(report), conn };
}

function normalizeEmail(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

function targetsOf(conn: StoredConnection): WorkflowTarget[] {
  return conn.attendanceWorkflows ?? [];
}

function targetFor(conn: StoredConnection, workflowId: string): WorkflowTarget | undefined {
  return targetsOf(conn).find((t) => t.workflowId === workflowId);
}

function sessionStartIso(session: SessionRecord): string {
  const time = Date.parse(session.startTime);
  return Number.isFinite(time) ? new Date(time).toISOString() : new Date().toISOString();
}

function workflowEventStart(session: SessionRecord, eventStartTime: 'now' | 'session_start' | undefined): string {
  return eventStartTime === 'session_start' ? sessionStartIso(session) : new Date().toISOString();
}

interface ApplyOneInput {
  session: SessionRecord;
  conn: StoredConnection;
  identity: string;
  email: string;
  name?: string;
  target: WorkflowTarget;
  source: WorkflowAssignmentSource;
  ruleId?: string;
  confidence?: number;
  reason?: string;
  eventStartTime: string;
  force?: boolean;
}

/**
 * Apply one workflow and always return a record instead of throwing. A person can only receive one
 * workflow per session: the Redis marker is checked before the lock, and set only after GHL accepts.
 */
async function applyOne(input: ApplyOneInput): Promise<WorkflowAssignmentRecord> {
  const base: WorkflowAssignmentRecord = {
    email: input.email,
    name: input.name,
    workflowId: input.target.workflowId,
    workflowName: input.target.name,
    source: input.source,
    ruleId: input.ruleId,
    confidence: input.confidence,
    reason: input.reason,
    status: 'failed',
    at: Date.now(),
  };

  const chosen = await getChosenWorkflow(input.session.id, input.identity).catch(() => undefined);
  if (chosen === input.target.workflowId) {
    return { ...base, status: 'skipped', error: 'this workflow is already applied' };
  }
  if (chosen && !input.force) {
    return { ...base, status: 'skipped', error: 'a different workflow is already applied to this person' };
  }

  const locked = await tryClaimWorkflowLock(input.session.id, input.identity).catch(() => false);
  if (!locked) {
    return { ...base, status: 'skipped', error: 'another dispatch is applying this person' };
  }

  try {
    const contact = await lookupContactByEmail(input.conn, input.email);
    if (!contact) return { ...base, status: 'failed', error: 'no GHL contact found for this email' };

    const ok = await addContactToWorkflow(
      input.conn,
      contact.id,
      input.target.workflowId,
      input.eventStartTime,
      `attendance-workflow:${input.session.id}:${input.identity}:${input.target.workflowId}`,
    );
    if (!ok) return { ...base, status: 'failed', error: 'GHL rejected the workflow request' };

    if (input.force && chosen && chosen !== input.target.workflowId) {
      await clearChosenWorkflow(input.session.id, input.identity).catch(() => undefined);
    }
    await saveChosenWorkflow(input.session.id, input.identity, input.target.workflowId);
    return { ...base, status: 'applied' };
  } catch (err) {
    return { ...base, status: 'failed', error: err instanceof Error ? err.message : String(err) };
  } finally {
    await releaseWorkflowLock(input.session.id, input.identity).catch(() => undefined);
  }
}

async function appendWorkflowAssignments(
  sessionId: string,
  records: WorkflowAssignmentRecord[],
): Promise<void> {
  if (!records.length) return;
  const current = await getSession(sessionId);
  if (!current) return;
  current.workflowAssignments = [...records, ...(current.workflowAssignments ?? [])].slice(0, 1000);
  current.workflowAssignedAt = Math.max(current.workflowAssignedAt ?? 0, ...records.map((r) => r.at));
  await saveSession(current);
}

export interface WorkflowApplyResult {
  applied: number;
  skipped: number;
  failed: number;
  records: WorkflowAssignmentRecord[];
}

function summarize(records: WorkflowAssignmentRecord[]): WorkflowApplyResult {
  return {
    applied: records.filter((r) => r.status === 'applied').length,
    skipped: records.filter((r) => r.status === 'skipped').length,
    failed: records.filter((r) => r.status === 'failed').length,
    records,
  };
}

/** Deterministic first-match routing. Called by the attendance dispatcher before any AI work. */
export async function applyWorkflowRules(
  session: SessionRecord,
  report: AttendanceReport,
  segments: AttendanceSegments,
  conn: StoredConnection,
): Promise<WorkflowApplyResult> {
  const targets = targetsOf(conn);
  const rules = conn.attendanceWorkflowRules ?? [];
  if (!targets.length || !rules.length) return summarize([]);

  const records: WorkflowAssignmentRecord[] = [];
  await forEachLimit(
    segmentEntries(segments),
    env.ATTENDANCE_DISPATCH_CONCURRENCY,
    async ({ segment, person }) => {
      const email = normalizeEmail(person.email);
      if (!email) return;

      try {
        const ctx = buildAttendanceContext(session, person, report, segment, segments);
        const rule = firstMatchingWorkflowRule(rules, ctx, person.behavior);
        if (!rule) return;

        const target = targetFor(conn, rule.workflowId);
        if (!target) {
          records.push({
            email,
            name: person.name,
            workflowId: rule.workflowId,
            source: 'rule',
            ruleId: rule.id,
            status: 'failed',
            error: 'workflow is no longer in the connection list',
            at: Date.now(),
          });
          return;
        }

        records.push(
          await applyOne({
            session,
            conn,
            identity: email,
            email,
            name: person.name,
            target,
            source: 'rule',
            ruleId: rule.id,
            eventStartTime: workflowEventStart(session, rule.eventStartTime),
          }),
        );
      } catch (err) {
        logger.warn({ err, sessionId: session.id, email }, 'workflow rule evaluation failed');
      }
    },
  );

  await appendWorkflowAssignments(session.id, records);
  logger.info(
    {
      sessionId: session.id,
      applied: records.filter((r) => r.status === 'applied').length,
      failed: records.filter((r) => r.status === 'failed').length,
    },
    'attendance workflow rules applied',
  );
  return summarize(records);
}

export interface WorkflowSelection {
  email: string;
  workflowId: string;
  /** Explicit operator override: allows replacing the chosen workflow and bypassing the AI threshold. */
  force?: boolean;
}

/** Apply a reviewed preview (rule and/or AI proposals). */
export async function applyWorkflowPreview(
  sessionId: string,
  selected: WorkflowSelection[],
): Promise<WorkflowApplyResult> {
  const { session, segments, conn } = await loadWorkflowContext(sessionId);
  if (!targetsOf(conn).length) throw new WorkflowRoutingError('no GHL workflows configured for this connection');

  const people = new Map<string, SegmentPerson>();
  for (const { person } of segmentEntries(segments)) {
    const email = normalizeEmail(person.email);
    if (email && !people.has(email)) people.set(email, person);
  }

  const proposals = new Map<string, WorkflowPreviewAssignment>();
  for (const a of session.workflowPreview?.assignments ?? []) {
    if (a.email && a.workflowId) proposals.set(`${normalizeEmail(a.email)}|${a.workflowId}`, a);
  }

  const seen = new Set<string>();
  const records: WorkflowAssignmentRecord[] = [];
  for (const sel of selected) {
    const email = normalizeEmail(sel.email);
    if (!email || seen.has(email)) continue;
    seen.add(email);

    const target = targetFor(conn, sel.workflowId);
    if (!target) {
      records.push({
        email,
        workflowId: sel.workflowId,
        source: 'manual',
        status: 'failed',
        error: 'workflow is not in the connection list',
        at: Date.now(),
      });
      continue;
    }

    const person = people.get(email);
    if (!person) {
      records.push({
        email,
        workflowId: sel.workflowId,
        workflowName: target.name,
        source: 'manual',
        status: 'failed',
        error: 'person is not in this session',
        at: Date.now(),
      });
      continue;
    }

    const proposal = proposals.get(`${email}|${sel.workflowId}`);
    if (proposal?.source === 'ai' && !proposal.eligible && !sel.force) {
      records.push({
        email,
        name: person.name,
        workflowId: sel.workflowId,
        workflowName: target.name,
        source: 'ai',
        confidence: proposal.confidence,
        reason: proposal.reason,
        status: 'skipped',
        error: 'AI confidence is below the threshold',
        at: Date.now(),
      });
      continue;
    }

    const rule = proposal?.ruleId
      ? (conn.attendanceWorkflowRules ?? []).find((r) => r.id === proposal.ruleId)
      : undefined;

    records.push(
      await applyOne({
        session,
        conn,
        identity: email,
        email,
        name: person.name,
        target,
        source: proposal?.source ?? 'manual',
        ruleId: proposal?.ruleId,
        confidence: proposal?.confidence,
        reason: proposal?.reason,
        eventStartTime: workflowEventStart(session, rule?.eventStartTime),
        force: sel.force,
      }),
    );
  }

  await appendWorkflowAssignments(session.id, records);
  return summarize(records);
}

async function aiPreview(
  session: SessionRecord,
  targets: WorkflowTarget[],
  candidates: Array<{ segment: string; person: SegmentPerson }>,
  assignmentsByEmail: Map<string, WorkflowPreviewAssignment>,
  rejected: string[],
  threshold: number,
): Promise<string | undefined> {
  const settings = await getAiSettings();
  if (!settings) return 'AI routing is enabled, but no AI provider key is configured.';

  const byId = new Map<string, { segment: string; person: SegmentPerson }>();
  const anonymous: AiAttendeeBehavior[] = candidates.map(({ segment, person }, i) => {
    const id = `p${i + 1}`;
    byId.set(id, { segment, person });
    return {
      id,
      segment,
      status: person.status,
      minutes: person.minutes,
      attentivenessScore: person.attentivenessScore,
      behavior: person.behavior,
    };
  });

  const allowed = new Set(targets.map((t) => t.workflowId));
  const batchSize = env.ATTENDANCE_AI_BATCH_SIZE;
  for (let i = 0; i < anonymous.length; i += batchSize) {
    const batch = anonymous.slice(i, i + batchSize);
    try {
      const raw = await generateJson<unknown>(
        settings,
        AI_SYSTEM_PROMPT,
        buildWorkflowAiPrompt({
          sessionTitle: session.title,
          sessionType: session.sessionType,
          sessionDate: session.startTime,
          workflows: targets,
          attendees: batch,
        }),
      );
      const validation = validateAiWorkflowResponse(
        raw,
        new Set(batch.map((a) => a.id)),
        allowed,
        threshold,
      );
      rejected.push(...validation.rejected);

      for (const choice of validation.choices) {
        const source = byId.get(choice.id);
        if (!source) continue;
        const email = normalizeEmail(source.person.email);
        if (!email || assignmentsByEmail.has(email)) continue;
        const target = choice.workflowId ? targets.find((t) => t.workflowId === choice.workflowId) : undefined;
        assignmentsByEmail.set(email, {
          email,
          name: source.person.name,
          workflowId: choice.workflowId,
          workflowName: target?.name,
          source: 'ai',
          confidence: choice.confidence,
          reason: choice.reason,
          eligible: choice.eligible,
        });
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }
  return undefined;
}

function previewHash(
  session: SessionRecord,
  report: AttendanceReport,
  segments: AttendanceSegments,
  conn: StoredConnection,
): string {
  const entries = segmentEntries(segments).map(({ segment, person }) => ({
    segment,
    email: normalizeEmail(person.email),
    name: person.name,
    status: person.status,
    minutes: person.minutes,
    behavior: person.behavior,
  }));
  return createHash('sha256')
    .update(
      JSON.stringify({
        session: {
          id: session.id,
          title: session.title,
          type: session.sessionType ?? 'meeting',
          startTime: session.startTime,
          endTime: session.endTime,
        },
        sessionStats: report.sessionStats ?? {},
        report: {
          invitedCount: report.invitedCount,
          attendedCount: report.attendedCount,
          noShowCount: report.noShowCount,
          registrantCount: report.registrantCount ?? 0,
          pollQuestionCount: report.pollQuestionCount ?? 0,
          pollRespondentCount: report.pollRespondentCount ?? 0,
          qaCount: (report.qa ?? []).length,
          absenteeCount: (report.absentees ?? []).length,
        },
        targets: conn.attendanceWorkflows ?? [],
        rules: conn.attendanceWorkflowRules ?? [],
        ai: conn.attendanceAiWorkflow ?? null,
        entries,
      }),
    )
    .digest('hex')
    .slice(0, 40);
}

/**
 * Build the operator preview: deterministic proposals first, then optional AI proposals for the
 * people no rule matched. The preview is cached against a content hash so re-opening the dialog does
 * not spend tokens again.
 */
export async function previewWorkflowAssignments(sessionId: string): Promise<WorkflowPreview> {
  const { session, report, segments, conn } = await loadWorkflowContext(sessionId);
  const targets = targetsOf(conn);
  const entries = segmentEntries(segments);
  const hash = previewHash(session, report, segments, conn);

  const cached = session.workflowPreview;
  if (cached && cached.behaviorHash === hash && !cached.error && Date.now() - cached.generatedAt < PREVIEW_CACHE_MS) {
    return cached;
  }

  const assignmentsByEmail = new Map<string, WorkflowPreviewAssignment>();
  const matched = new Set<string>();
  const rejected: string[] = [];
  let error: string | undefined;

  if (!targets.length) {
    error = 'No GHL workflows have been added for this connection.';
  } else {
    for (const { segment, person } of entries) {
      const email = normalizeEmail(person.email);
      if (!email) continue;
      try {
        const ctx = buildAttendanceContext(session, person, report, segment, segments);
        const rule = firstMatchingWorkflowRule(conn.attendanceWorkflowRules, ctx, person.behavior);
        if (!rule) continue;
        const target = targets.find((t) => t.workflowId === rule.workflowId);
        if (!target) continue;
        assignmentsByEmail.set(email, {
          email,
          name: person.name,
          workflowId: target.workflowId,
          workflowName: target.name,
          source: 'rule',
          ruleId: rule.id,
          eligible: true,
        });
        matched.add(email);
      } catch (err) {
        logger.warn({ err, sessionId: session.id, email }, 'workflow rule preview failed');
      }
    }

    const ai = conn.attendanceAiWorkflow;
    if (ai?.enabled) {
      const candidates = entries.filter(({ person }) => {
        const email = normalizeEmail(person.email);
        return !!email && !matched.has(email);
      });
      const capped = ai.maxAttendees > 0 ? candidates.slice(0, ai.maxAttendees) : candidates;
      if (capped.length) {
        const aiError = await aiPreview(
          session,
          targets,
          capped,
          assignmentsByEmail,
          rejected,
          ai.confidenceThreshold,
        );
        if (aiError) error = aiError;
      }
    }
  }

  const assignments: WorkflowPreviewAssignment[] = [];
  for (const { person } of entries) {
    const email = normalizeEmail(person.email);
    const assignment = email ? assignmentsByEmail.get(email) : undefined;
    if (assignment) assignments.push(assignment);
  }

  const preview: WorkflowPreview = {
    generatedAt: Date.now(),
    behaviorHash: hash,
    assignments,
    rejected: rejected.length ? [...new Set(rejected)] : undefined,
    error,
  };

  const latest = await getSession(sessionId);
  if (latest) {
    latest.workflowPreview = preview;
    await saveSession(latest);
  }
  return preview;
}

/** Automatic AI mode. Rules have already run; this only applies eligible AI proposals. */
export async function autoAssignAiWorkflows(
  sessionId: string,
  conn: StoredConnection,
): Promise<WorkflowApplyResult> {
  const settings = conn.attendanceAiWorkflow;
  if (!settings?.enabled || settings.mode !== 'auto' || !targetsOf(conn).length) return summarize([]);

  const current = await getSession(sessionId);
  if (!current) return summarize([]);
  const report = await getAttendance(sessionId);
  if (!report) return summarize([]);
  const hash = previewHash(current, report, buildAttendanceSegments(report), conn);
  if (current.workflowAiHash === hash) return summarize([]);

  const preview = await previewWorkflowAssignments(sessionId);
  if (preview.error) {
    logger.warn({ sessionId, error: preview.error }, 'AI workflow preview failed; skipping automatic assignment');
    return summarize([]);
  }

  const selected: WorkflowSelection[] = [];
  for (const a of preview.assignments) {
    if (a.source === 'ai' && a.eligible && a.workflowId && a.email) {
      selected.push({ email: a.email, workflowId: a.workflowId, force: false });
    }
  }
  if (!selected.length) {
    await rememberAiHash(sessionId, preview.behaviorHash);
    return summarize([]);
  }

  const result = await applyWorkflowPreview(sessionId, selected);
  if (result.failed === 0) await rememberAiHash(sessionId, preview.behaviorHash);
  return result;
}

/** Remember that automatic AI saw this exact content, so an unchanged hourly sync does not re-spend. */
async function rememberAiHash(sessionId: string, hash: string): Promise<void> {
  const latest = await getSession(sessionId);
  if (!latest) return;
  latest.workflowAiHash = hash;
  await saveSession(latest);
}

/** Manual single-person assignment from the session detail. */
export async function assignWorkflowToPerson(
  sessionId: string,
  emailRaw: string,
  workflowId: string,
  force = false,
): Promise<WorkflowAssignmentRecord> {
  const { session, segments, conn } = await loadWorkflowContext(sessionId);
  const email = normalizeEmail(emailRaw);
  if (!email) throw new WorkflowRoutingError('an email is required to add a contact to a workflow');

  const target = targetFor(conn, workflowId);
  if (!target) throw new WorkflowRoutingError('workflow is not in the connection list', 404);

  const person = segmentEntries(segments).find((e) => normalizeEmail(e.person.email) === email)?.person;
  if (!person) throw new WorkflowRoutingError('person is not in this session', 404);

  const record = await applyOne({
    session,
    conn,
    identity: email,
    email,
    name: person.name,
    target,
    source: 'manual',
    eventStartTime: new Date().toISOString(),
    force,
  });
  await appendWorkflowAssignments(session.id, [record]);
  return record;
}



