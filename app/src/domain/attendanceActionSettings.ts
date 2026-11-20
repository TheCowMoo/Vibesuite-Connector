import { z } from 'zod';
import type {
  AttendanceActionSnapshot,
  AttendanceAiWorkflowSettings,
  AttendanceRosterSettings,
  AttendanceTags,
  AttendanceWorkflowRule,
  AutomationRule,
  DeliveryMode,
  WorkflowTarget,
} from './connection';
import { DEFAULT_ATTENDANCE_AI } from './attendanceActions';
import { normalizeRosterShape } from './attendanceRoster';
import { parseWorkflowSettings } from './workflowSettings';

export interface AttendanceActionSettingsInput {
  attendanceDeliveryMode?: unknown;
  attendanceRules?: unknown;
  attendanceTags?: unknown;
  attendanceCustomFieldId?: unknown;
  attendanceWorkflows?: unknown;
  attendanceWorkflowRules?: unknown;
  attendanceAiWorkflow?: unknown;
  attendanceRoster?: unknown;
  clearAttendanceRosterToken?: unknown;
}

export interface ParsedAttendanceActionSettings {
  deliveryMode: DeliveryMode;
  tags?: AttendanceTags;
  customFieldId?: string;
  workflows: WorkflowTarget[];
  workflowRules: AttendanceWorkflowRule[];
  aiWorkflow: AttendanceAiWorkflowSettings;
  rules: AutomationRule[];
  roster?: AttendanceRosterSettings;
  /** Plaintext token for the caller to seal before storing. */
  rosterToken?: string;
  clearRosterToken: boolean;
}

export type AttendanceActionSettingsResult =
  | { ok: true; value: ParsedAttendanceActionSettings }
  | { ok: false; error: string; details?: unknown };

const tagsSchema = z
  .object({
    attended: z.string().trim().max(200).optional(),
    partial: z.string().trim().max(200).optional(),
    noShow: z.string().trim().max(200).optional(),
    notInvited: z.string().trim().max(200).optional(),
  })
  .strict();

const conditionSchema = z.object({
  field: z.string().trim().min(1),
  operator: z.string().trim().min(1),
  value: z.string().optional(),
});

const automationRuleSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  enabled: z.boolean(),
  conditions: z.array(conditionSchema).default([]),
  webhookUrl: z.string().trim().max(2048).default(''),
});

const rosterSchema = z.object({
  url: z.string().trim().max(2048).optional(),
  shape: z.string().trim().optional(),
  token: z.string().trim().max(5000).optional(),
});

function parseTags(
  value: unknown,
  existing?: AttendanceTags,
): { ok: true; value?: AttendanceTags } | { ok: false } {
  if (value === undefined) return { ok: true, value: existing };
  if (value === null) return { ok: true };
  const parsed = tagsSchema.safeParse(value);
  if (!parsed.success) return { ok: false };
  const clean = (v?: string) => (v && v.trim() ? v.trim() : undefined);
  const out: AttendanceTags = {
    attended: clean(parsed.data.attended),
    partial: clean(parsed.data.partial),
    noShow: clean(parsed.data.noShow),
    notInvited: clean(parsed.data.notInvited),
  };
  return { ok: true, value: Object.values(out).some(Boolean) ? out : undefined };
}

/**
 * Validate the full after-call action payload.
 *
 * The same shape is used by the account template and by a call's own copy, so a call cannot save
 * rules that point outside its workflow list or a malformed report webhook.
 */
export function parseAttendanceActionSettings(
  body: AttendanceActionSettingsInput,
  existing?: AttendanceActionSnapshot,
): AttendanceActionSettingsResult {
  const mode = body.attendanceDeliveryMode === undefined
    ? existing?.deliveryMode ?? 'both'
    : body.attendanceDeliveryMode;
  if (mode !== 'api' && mode !== 'webhook' && mode !== 'both') {
    return { ok: false, error: 'invalid attendance delivery mode' };
  }

  const workflowsInput = body.attendanceWorkflows === undefined ? existing?.workflows ?? [] : body.attendanceWorkflows;
  const rulesInput = body.attendanceWorkflowRules === undefined
    ? existing?.workflowRules ?? []
    : body.attendanceWorkflowRules;
  const aiInput = body.attendanceAiWorkflow === undefined
    ? existing?.aiWorkflow ?? DEFAULT_ATTENDANCE_AI
    : body.attendanceAiWorkflow;

  const workflowParsed = parseWorkflowSettings({
    attendanceWorkflows: workflowsInput,
    attendanceWorkflowRules: rulesInput,
    attendanceAiWorkflow: aiInput,
  });
  if (!workflowParsed.ok) {
    return { ok: false, error: workflowParsed.error, details: workflowParsed.details };
  }

  const tagsParsed = parseTags(body.attendanceTags, existing?.tags);
  if (!tagsParsed.ok) return { ok: false, error: 'invalid attendance tags' };
  const tags = tagsParsed.value;

  let customFieldId = existing?.customFieldId;
  if (body.attendanceCustomFieldId !== undefined) {
    if (body.attendanceCustomFieldId !== null && typeof body.attendanceCustomFieldId !== 'string') {
      return { ok: false, error: 'invalid custom field id' };
    }
    customFieldId = typeof body.attendanceCustomFieldId === 'string'
      ? body.attendanceCustomFieldId.trim() || undefined
      : undefined;
  }

  let rules = existing?.rules ?? [];
  if (body.attendanceRules !== undefined) {
    const parsed = z.array(automationRuleSchema).max(200).safeParse(body.attendanceRules);
    if (!parsed.success) {
      return { ok: false, error: 'invalid per-person webhook rules', details: parsed.error.flatten() };
    }
    rules = parsed.data as AutomationRule[];
  }

  let roster = existing?.roster;
  let rosterToken: string | undefined;
  let clearRosterToken = body.clearAttendanceRosterToken === true;
  if (body.attendanceRoster !== undefined) {
    if (body.attendanceRoster === null) {
      roster = undefined;
    } else {
      const parsed = rosterSchema.safeParse(body.attendanceRoster);
      if (!parsed.success) {
        return { ok: false, error: 'invalid call-report webhook settings', details: parsed.error.flatten() };
      }
      const url = parsed.data.url?.trim() || '';
      if (url && !/^https?:\/\/\S+$/i.test(url)) {
        return { ok: false, error: 'call report webhook URL must start with http:// or https://' };
      }
      roster = url
        ? { url, shape: normalizeRosterShape(parsed.data.shape, existing?.roster?.shape ?? 'flat') }
        : undefined;
      rosterToken = parsed.data.token?.trim() || undefined;
    }
    clearRosterToken = body.clearAttendanceRosterToken === true;
  }

  return {
    ok: true,
    value: {
      deliveryMode: mode,
      ...(tags ? { tags } : {}),
      ...(customFieldId ? { customFieldId } : {}),
      workflows: workflowParsed.value.attendanceWorkflows ?? [],
      workflowRules: workflowParsed.value.attendanceWorkflowRules ?? [],
      aiWorkflow: workflowParsed.value.attendanceAiWorkflow ?? DEFAULT_ATTENDANCE_AI,
      rules,
      ...(roster ? { roster } : {}),
      ...(rosterToken ? { rosterToken } : {}),
      clearRosterToken,
    },
  };
}
