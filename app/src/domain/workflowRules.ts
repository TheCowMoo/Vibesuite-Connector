import { matchesCondition, type ConditionContext } from './condition';
import type { AttendanceWorkflowRule, PollCondition } from './connection';
import type { ZoomBehavior } from './zoomBehavior';

function norm(value: string | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Poll conditions are deliberately separate from the generic fields: a poll answer is a list of
 * question/answer pairs, not a single scalar, and "answered" is not a string comparison.
 *
 * If the question was not present in this session, every operator is false. That is safer than
 * firing a "not answered" rule for every attendee when the host simply skipped the poll.
 */
export function matchesPollCondition(cond: PollCondition, behavior: ZoomBehavior | undefined): boolean {
  if (!behavior) return false;
  const question = norm(cond.question);
  const answers = behavior.pollAnswers.filter((a) => norm(a.question) === question);
  const questionPresent = (behavior.pollQuestions ?? []).some((q) => norm(q) === question);
  if (!answers.length) return cond.operator === 'not_answered' && questionPresent;

  const expected = norm(cond.answer);
  switch (cond.operator) {
    case 'answered':
      return answers.some((a) => a.answer.trim() !== '');
    case 'not_answered':
      return answers.every((a) => a.answer.trim() === '');
    case 'equals':
      return answers.some((a) => norm(a.answer) === expected);
    case 'not_equals':
      return answers.every((a) => norm(a.answer) !== expected);
    case 'contains':
      return answers.some((a) => norm(a.answer).includes(expected));
    case 'not_contains':
      return answers.every((a) => !norm(a.answer).includes(expected));
    default:
      return false;
  }
}

/** All conditions AND all poll conditions must match. An empty rule is a catch-all. */
export function workflowRuleMatches(
  rule: AttendanceWorkflowRule,
  ctx: ConditionContext,
  behavior: ZoomBehavior | undefined,
): boolean {
  if (!rule.enabled || !String(rule.workflowId ?? '').trim()) return false;
  const conditions = rule.conditions ?? [];
  const pollConditions = rule.pollConditions ?? [];
  if (conditions.length === 0 && pollConditions.length === 0) return true;
  if (!conditions.every((c) => matchesCondition(c, ctx))) return false;
  return pollConditions.every((c) => matchesPollCondition(c, behavior));
}

/** Rules are checked in order; the first enabled match wins. */
export function firstMatchingWorkflowRule(
  rules: AttendanceWorkflowRule[] | undefined,
  ctx: ConditionContext,
  behavior: ZoomBehavior | undefined,
): AttendanceWorkflowRule | undefined {
  return (rules ?? []).find((rule) => workflowRuleMatches(rule, ctx, behavior));
}

export interface AiAttendeeBehavior {
  /** Anonymous id sent to the model (p1, p2, …). */
  id: string;
  segment: string;
  status: string;
  minutes?: number;
  attentivenessScore?: number;
  behavior?: ZoomBehavior;
}

export interface AiWorkflowChoice {
  id: string;
  workflowId: string | null;
  confidence: number;
  reason?: string;
  eligible: boolean;
}

export interface AiWorkflowValidation {
  choices: AiWorkflowChoice[];
  rejected: string[];
}

function confidenceOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The model is allowed to propose, never to invent. Unknown attendee ids and unknown workflow ids
 * are dropped here, before anything can reach GHL.
 */
export function validateAiWorkflowResponse(
  raw: unknown,
  inputIds: Set<string>,
  allowedWorkflowIds: Set<string>,
  threshold: number,
): AiWorkflowValidation {
  const source = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { assignments?: unknown }).assignments)
      ? (raw as { assignments: unknown[] }).assignments
      : [];

  const rejected: string[] = [];
  if (!source.length) rejected.push('the model returned no assignments');

  const byId = new Map<string, AiWorkflowChoice>();
  for (const item of source) {
    if (!item || typeof item !== 'object') {
      rejected.push('an assignment was not an object');
      continue;
    }
    const row = item as Record<string, unknown>;
    const id = String(row.id ?? '').trim();
    if (!id || !inputIds.has(id)) {
      rejected.push(`unknown attendee id “${id || '?'}”`);
      continue;
    }

    const rawWorkflow = row.workflowId;
    const workflowId = typeof rawWorkflow === 'string' && rawWorkflow.trim() ? rawWorkflow.trim() : null;
    if (workflowId && !allowedWorkflowIds.has(workflowId)) {
      rejected.push(`unknown workflow id “${workflowId}”`);
      continue;
    }

    const confidence = confidenceOf(row.confidence);
    const reason = typeof row.reason === 'string' ? row.reason.trim().slice(0, 300) : undefined;
    const choice: AiWorkflowChoice = {
      id,
      workflowId,
      confidence,
      reason: reason || undefined,
      eligible: !!workflowId && confidence >= threshold,
    };

    const existing = byId.get(id);
    if (!existing || choice.confidence > existing.confidence) byId.set(id, choice);
  }

  return { choices: [...byId.values()], rejected };
}

function aiBehavior(entry: AiAttendeeBehavior): Record<string, unknown> {
  const b = entry.behavior;
  return {
    id: entry.id,
    segment: entry.segment,
    status: entry.status,
    minutes: entry.minutes,
    attentivenessScore: entry.attentivenessScore,
    joinedLateMinutes: b?.joinedLateMinutes,
    leftEarlyMinutes: b?.leftEarlyMinutes,
    attendedPortionPct: b?.attendedPortionPct,
    pollQuestions: b?.pollQuestions ?? [],
    pollQuestionCount: b?.pollQuestionCount,
    pollAnsweredCount: b?.pollAnsweredCount,
    pollAnswers: b?.pollAnswers ?? [],
    qa: b?.qa ?? [],
    qaAskedCount: b?.qaAskedCount,
    qaAnsweredCount: b?.qaAnsweredCount,
    registrationAnswers: b?.registrationAnswers ?? [],
    device: b?.device,
    location: b?.location,
    networkType: b?.networkType,
    microphone: b?.microphone,
    camera: b?.camera,
    connectionType: b?.connectionType,
    shareDesktop: b?.shareDesktop,
    shareApplication: b?.shareApplication,
  };
}

/**
 * Build the user prompt. Identity is stripped on purpose: the model only sees anonymous ids and the
 * behavior signals it is allowed to reason about.
 */
export function buildWorkflowAiPrompt(input: {
  sessionTitle?: string;
  sessionType?: string;
  sessionDate?: string;
  workflows: Array<{ workflowId: string; name: string; criteria?: string }>;
  attendees: AiAttendeeBehavior[];
}): string {
  return [
    `Session: ${input.sessionTitle ?? 'Video call'} (${input.sessionType ?? 'meeting'}${input.sessionDate ? `, ${input.sessionDate}` : ''})`,
    '',
    'Allowed workflows (choose only these workflowId values):',
    JSON.stringify(
      input.workflows.map((w) => ({ workflowId: w.workflowId, name: w.name, criteria: w.criteria ?? '' })),
      null,
      2,
    ),
    '',
    'Attendees (anonymous ids):',
    JSON.stringify(input.attendees.map(aiBehavior), null, 2),
    '',
    'Return JSON exactly in this shape:',
    '{"assignments":[{"id":"p1","workflowId":"the allowed id or null","confidence":0.0,"reason":"short reason"}]}',
    'One entry per attendee. Use workflowId null when no workflow clearly fits. Do not invent ids.',
  ].join('\n');
}
