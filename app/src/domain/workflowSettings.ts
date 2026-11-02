import { z } from 'zod';
import type {
  AttendanceAiWorkflowSettings,
  AttendanceWorkflowRule,
  WorkflowTarget,
} from './connection';

const conditionSchema = z.object({
  field: z.string().trim().min(1),
  operator: z.string().trim().min(1),
  value: z.string().optional(),
});

const pollConditionSchema = z
  .object({
    question: z.string().trim().min(1),
    operator: z.enum(['answered', 'not_answered', 'equals', 'not_equals', 'contains', 'not_contains']),
    answer: z.string().trim().optional(),
  })
  .refine(
    (c) => c.operator === 'answered' || c.operator === 'not_answered' || !!(c.answer && c.answer.trim()),
    { message: 'a poll condition needs an answer unless it is answered / not answered' },
  );

const workflowTargetSchema = z.object({
  id: z.string().trim().min(1),
  workflowId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  criteria: z.string().trim().max(2000).optional(),
});

const workflowRuleSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  conditions: z.array(conditionSchema).default([]),
  pollConditions: z.array(pollConditionSchema).optional(),
  workflowId: z.string().trim().min(1),
  eventStartTime: z.enum(['now', 'session_start']).optional(),
});

const aiWorkflowSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['preview', 'auto']),
  confidenceThreshold: z.number().min(0).max(1),
  maxAttendees: z.number().int().min(0).max(10000),
});

export interface WorkflowSettingsPatch {
  attendanceWorkflows?: WorkflowTarget[];
  attendanceWorkflowRules?: AttendanceWorkflowRule[];
  attendanceAiWorkflow?: AttendanceAiWorkflowSettings;
}

export type WorkflowSettingsResult =
  | { ok: true; value: WorkflowSettingsPatch }
  | { ok: false; error: string; details?: unknown };

/**
 * Validate the workflow settings received from the UI. Rules may only point at a workflow that is
 * in the same connection's target list, so a typo cannot silently route contacts to nowhere.
 */
export function parseWorkflowSettings(body: {
  attendanceWorkflows?: unknown;
  attendanceWorkflowRules?: unknown;
  attendanceAiWorkflow?: unknown;
}): WorkflowSettingsResult {
  const out: WorkflowSettingsPatch = {};

  if (body.attendanceWorkflows !== undefined) {
    const parsed = z.array(workflowTargetSchema).max(100).safeParse(body.attendanceWorkflows);
    if (!parsed.success) return { ok: false, error: 'invalid workflow list', details: parsed.error.flatten() };
    const ids = new Set(parsed.data.map((t) => t.id));
    const workflowIds = new Set(parsed.data.map((t) => t.workflowId));
    if (ids.size !== parsed.data.length) return { ok: false, error: 'workflow target ids must be unique' };
    if (workflowIds.size !== parsed.data.length) return { ok: false, error: 'GHL workflow ids must be unique' };
    out.attendanceWorkflows = parsed.data;
  }

  if (body.attendanceWorkflowRules !== undefined) {
    const parsed = z.array(workflowRuleSchema).max(200).safeParse(body.attendanceWorkflowRules);
    if (!parsed.success) return { ok: false, error: 'invalid workflow rules', details: parsed.error.flatten() };
    const ids = new Set(parsed.data.map((r) => r.id));
    if (ids.size !== parsed.data.length) return { ok: false, error: 'workflow rule ids must be unique' };
    out.attendanceWorkflowRules = parsed.data as AttendanceWorkflowRule[];
  }

  if (body.attendanceAiWorkflow !== undefined) {
    const parsed = aiWorkflowSchema.safeParse(body.attendanceAiWorkflow);
    if (!parsed.success) return { ok: false, error: 'invalid AI workflow settings', details: parsed.error.flatten() };
    out.attendanceAiWorkflow = parsed.data;
  }

  const rules = out.attendanceWorkflowRules;
  const targets = out.attendanceWorkflows;
  if (rules?.length && !targets?.length) {
    return { ok: false, error: 'add at least one workflow before creating a workflow rule' };
  }
  if (rules?.length && targets?.length) {
    const known = new Set(targets.map((t) => t.workflowId));
    const missing = rules.find((r) => !known.has(r.workflowId));
    if (missing) return { ok: false, error: `rule “${missing.name}” points at a workflow that is not in the list` };
  }

  return { ok: true, value: out };
}
