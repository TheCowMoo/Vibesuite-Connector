export const ADVISOR_ACTION_KINDS = [
  'set_sender_daily_cap',
  'set_sender_hourly_cap',
  'set_sender_min_delay_ms',
  'set_sender_window',
  'pause_sender',
  'resume_sender',
  'set_campaign_priority',
  'set_campaign_status',
] as const;

export type AdvisorActionKind = (typeof ADVISOR_ACTION_KINDS)[number];
export type RecommendationState = 'open' | 'applied' | 'dismissed';
export type Severity = 'info' | 'warning' | 'critical';

export interface AdvisorAction {
  kind: string;
  /** A snapshot label such as `Mailbox B` or `Campaign 1` — never a raw id. */
  target?: string;
  value?: number;
  startHour?: number;
  endHour?: number;
  days?: number[];
  status?: string;
}

export interface Recommendation {
  id: string;
  title: string;
  severity: Severity;
  rationale: string;
  impact?: string;
  action?: AdvisorAction;
  actionLabel?: string;
  state: RecommendationState;
  appliedAt?: number;
}

export type ClampResult =
  | { ok: true; action: AdvisorAction; description: string }
  | { ok: false; error: string };

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampDays(days: unknown): number[] | undefined {
  if (!Array.isArray(days)) return undefined;
  const out = Array.from(
    new Set(days.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)),
  ).sort((a, b) => a - b);
  return out.length ? out : undefined;
}

export function isAdvisorActionKind(kind: string): kind is AdvisorActionKind {
  return (ADVISOR_ACTION_KINDS as readonly string[]).includes(kind);
}

/**
 * Server-side clamp. The model's numbers are never trusted: every field is range-checked
 * here, and any action that does not survive clamping is dropped rather than applied.
 */
export function clampAdvisorAction(input: AdvisorAction | undefined): ClampResult {
  const kind = String(input?.kind ?? '');
  if (!isAdvisorActionKind(kind)) return { ok: false, error: `That change is not one the assistant is allowed to make (${kind}).` };

  const target = typeof input?.target === 'string' ? input.target.trim() : '';
  if (!target) return { ok: false, error: 'that suggestion does not say which account or bulk invite it means' };

  switch (kind) {
    case 'set_sender_daily_cap': {
      const value = clampInt(input?.value, 1, 5000);
      if (value === undefined) return { ok: false, error: 'the daily limit needs to be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: max per day → ${value}` };
    }

    case 'set_sender_hourly_cap': {
      const value = clampInt(input?.value, 1, 1000);
      if (value === undefined) return { ok: false, error: 'the hourly limit needs to be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: max per hour → ${value}` };
    }

    case 'set_sender_min_delay_ms': {
      const value = clampInt(input?.value, 0, 600000);
      if (value === undefined) return { ok: false, error: 'the pause needs to be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: pause between batches → ${value}ms` };
    }

    case 'set_sender_window': {
      const startHour = clampInt(input?.startHour, 0, 23);
      const endHour = clampInt(input?.endHour, 0, 23);
      if (startHour === undefined || endHour === undefined) return { ok: false, error: 'sending hours need a start and an end' };
      const days = clampDays(input?.days) ?? [1, 2, 3, 4, 5];
      return {
        ok: true,
        action: { kind, target, startHour, endHour, days },
        description: `${target}: send between ${startHour}:00 and ${endHour}:00 on days ${days.join(',')}`,
      };
    }

    case 'pause_sender':
      return { ok: true, action: { kind, target }, description: `${target}: pause sending` };

    case 'resume_sender':
      return { ok: true, action: { kind, target }, description: `${target}: start sending again` };

    case 'set_campaign_priority': {
      const value = clampInt(input?.value, 0, 10);
      if (value === undefined) return { ok: false, error: 'priority needs to be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: priority → ${value}` };
    }

    case 'set_campaign_status': {
      const status = String(input?.status ?? '');
      if (status !== 'active' && status !== 'paused') return { ok: false, error: 'a bulk invite can only be turned on or paused' };
      return { ok: true, action: { kind, target, status }, description: `${target}: status → ${status}` };
    }

    default:
      return { ok: false, error: `That change is not one the assistant is allowed to make (${kind}).` };
  }
}
