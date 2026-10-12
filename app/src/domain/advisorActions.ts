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
  if (!isAdvisorActionKind(kind)) return { ok: false, error: `unsupported action "${kind}"` };

  const target = typeof input?.target === 'string' ? input.target.trim() : '';
  if (!target) return { ok: false, error: 'action is missing a target' };

  switch (kind) {
    case 'set_sender_daily_cap': {
      const value = clampInt(input?.value, 1, 5000);
      if (value === undefined) return { ok: false, error: 'daily cap must be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: daily cap → ${value}` };
    }

    case 'set_sender_hourly_cap': {
      const value = clampInt(input?.value, 1, 1000);
      if (value === undefined) return { ok: false, error: 'hourly cap must be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: hourly cap → ${value}` };
    }

    case 'set_sender_min_delay_ms': {
      const value = clampInt(input?.value, 0, 600000);
      if (value === undefined) return { ok: false, error: 'min delay must be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: min delay → ${value}ms` };
    }

    case 'set_sender_window': {
      const startHour = clampInt(input?.startHour, 0, 23);
      const endHour = clampInt(input?.endHour, 0, 23);
      if (startHour === undefined || endHour === undefined) return { ok: false, error: 'window needs a start and end hour' };
      const days = clampDays(input?.days) ?? [1, 2, 3, 4, 5];
      return {
        ok: true,
        action: { kind, target, startHour, endHour, days },
        description: `${target}: window → ${startHour}:00–${endHour}:00 on days ${days.join(',')}`,
      };
    }

    case 'pause_sender':
      return { ok: true, action: { kind, target }, description: `${target}: pause` };

    case 'resume_sender':
      return { ok: true, action: { kind, target }, description: `${target}: resume` };

    case 'set_campaign_priority': {
      const value = clampInt(input?.value, 0, 10);
      if (value === undefined) return { ok: false, error: 'priority must be a number' };
      return { ok: true, action: { kind, target, value }, description: `${target}: priority → ${value}` };
    }

    case 'set_campaign_status': {
      const status = String(input?.status ?? '');
      if (status !== 'active' && status !== 'paused') return { ok: false, error: 'campaign status must be active or paused' };
      return { ok: true, action: { kind, target, status }, description: `${target}: status → ${status}` };
    }

    default:
      return { ok: false, error: `unsupported action "${kind}"` };
  }
}
