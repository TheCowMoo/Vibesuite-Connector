import { z } from 'zod';
import { dailyCapFor, type SenderProfile } from './senderLoad';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'scheduled' | 'ended';
export type RecipientStatus = 'pending' | 'sent' | 'failed';
export type DistributionMode = 'even' | 'weighted';

export const CampaignSenderSchema = z.object({
  connectionId: z.string().min(1),
  enabled: z.boolean().default(true),
  quota: z.number().int().min(0).optional(),
  share: z.number().min(0).optional(),
  priority: z.number().int().min(0).default(5),
});

export const CampaignEventSchema = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  location: z.string().optional(),
  start: z.string().min(1),
  end: z.string().min(1),
  timeZone: z.string().optional(),
});

/** A copy variant id. Excel-style letters (A, B, …, Z, AA, AB, …) with no practical limit. */
export type CopyVariantId = string;

/** An optional link the operator pastes; blank is absent, and only http(s) is accepted. */
const OptionalHttpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => /^https?:\/\/\S+$/i.test(value), { message: 'must be an http(s) link' });

export const CopyVariantSchema = z.object({
  id: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]+$/, 'variant ids are letters: A, B, C, …')
    .max(10),
  summary: z.string().min(1),
  description: z.string().optional(),
  /**
   * Optional Zoom registration link for this variant's calendar event. When set, it replaces the
   * campaign's linked-call link; blank means "use the campaign default".
   */
  registrationUrl: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    OptionalHttpUrl.optional(),
  ),
});
export type CopyVariant = z.infer<typeof CopyVariantSchema>;

export const CopyVariantsSchema = z
  .array(CopyVariantSchema)
  .min(1)
  .refine((variants) => new Set(variants.map((v) => v.id)).size === variants.length, {
    message: 'copy variant ids must be unique',
  })
  .refine((variants) => variants.some((v) => v.id === 'A'), {
    message: 'variant A is required as the base copy',
  });

export const CampaignSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'scheduled', 'ended']).default('draft'),
  listId: z.string().min(1),
  segments: z.array(z.string()).default([]),
  sessionId: z.string().optional(),
  /** Which authorised Zoom host runs this campaign's webinar. Shared pool, one per campaign. */
  zoomUserId: z.string().optional(),
  event: CampaignEventSchema,
  /**
   * Optional copy test. Each active variant gets its own calendar event(s), because Google
   * Calendar has one summary/description per event. Absent means the original single-copy campaign.
   */
  copyVariants: CopyVariantsSchema.optional(),
  senders: z.array(CampaignSenderSchema).min(1),
  distribution: z.object({ mode: z.enum(['even', 'weighted']).default('even') }).default({ mode: 'even' }),
  /**
   * Deliberately re-invite people who already received an invitation for this list. Off by default:
   * a second send silently re-inviting everyone is exactly what the invited-set filter prevents.
   */
  includeAlreadyInvited: z.boolean().default(false),
  /** When the scheduler should freeze the audience and begin sending. */
  scheduledStartAt: z.number().int().optional(),
  /** Optional deadline: sending stops once this is reached. */
  sendByAt: z.number().int().optional(),
  /**
   * When set, each round creates one event per account with at most this many recipients, then
   * waits `batchDelayMinutes` before the next round. Off when absent.
   */
  eventBatchSize: z.number().int().min(1).max(1000).optional(),
  batchDelayMinutes: z.number().int().min(0).optional(),
  /** Runtime gate: the scheduler will not send this campaign before this time. */
  nextBatchAt: z.number().int().optional(),
  lastBatchAt: z.number().int().optional(),
  /** Why a scheduled activation failed — surfaced on the card so it cannot fail silently. */
  lastError: z.string().optional(),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
});

export type CampaignSender = z.infer<typeof CampaignSenderSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;

export interface RecipientRecord {
  email: string;
  connectionId: string;
  status: RecipientStatus;
  sentAt?: number;
  eventId?: string;
  /** Which copy variant this recipient received. Absent on pre-variant campaigns. */
  variant?: CopyVariantId;
  error?: string;
}

/**
 * The configured split as whole percentages that add up to 100.
 *
 * `share` is stored as a relative weight, not necessarily a percentage: campaigns created before
 * percentages were shown carry values such as 1 / 2 / 1. Normalising here means old records,
 * cards and exports still describe the same split. A zero weight means "do not use this account";
 * only when every weight is zero (a legacy record) does it fall back to an even split.
 */
export function sharePercents(senders: CampaignSender[]): Record<string, number> {
  const active = senders.filter((s) => s && s.enabled);
  const out: Record<string, number> = {};
  active.forEach((s) => {
    out[s.connectionId] = 0;
  });
  if (!active.length) return out;

  const weights = active.map((s) => {
    const n = Number(s.share);
    return Number.isFinite(n) ? Math.max(0, n) : 1;
  });
  const hasPositive = weights.some((w) => w > 0);
  const effective = hasPositive ? weights : active.map(() => 1);
  const weightSum = effective.reduce((a, w) => a + w, 0);
  if (weightSum <= 0) return out;

  const raw = effective.map((w) => (w / weightSum) * 100);
  const whole = raw.map(Math.floor);
  let left = 100 - whole.reduce((a, n) => a + n, 0);
  const order = raw
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .filter(({ index }) => effective[index] > 0)
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  for (let i = 0; left > 0 && order.length; i += 1) {
    whole[order[i % order.length].index] += 1;
    left -= 1;
  }

  active.forEach((s, i) => {
    out[s.connectionId] = whole[i];
  });
  return out;
}

/**
 * Keep the stored label honest: shares within one point of each other are even.
 *
 * A three-way equal split rounds to 34 / 33 / 33, so exact equality would wrongly call the
 * default split "custom". Any zero share, or a gap wider than one point, is custom.
 */
export function distributionMode(senders: CampaignSender[]): DistributionMode {
  const active = senders.filter((s) => s && s.enabled);
  if (active.length < 2) return 'even';
  const percents = sharePercents(senders);
  const values = active.map((s) => percents[s.connectionId] ?? 0);
  if (values.some((v) => v <= 0)) return 'weighted';
  return Math.max(...values) - Math.min(...values) <= 1 ? 'even' : 'weighted';
}

/**
 * Split `total` across enabled senders by share/quota, redistributing the remainder.
 *
 * A zero share excludes an account from both the initial split and the overflow, which is what
 * the percentage UI means by 0%. If every active account has a zero share, the old even-split
 * behaviour is kept so a legacy record cannot silently send nothing.
 */
export function computeAllocation(total: number, senders: CampaignSender[]): Record<string, number> {
  const active = senders.filter((s) => s.enabled);
  const alloc: Record<string, number> = {};
  if (!active.length || total <= 0) return alloc;

  active.forEach((s) => {
    alloc[s.connectionId] = 0;
  });

  const rawWeights = active.map((s) => {
    const n = Number(s.share);
    return Number.isFinite(n) ? Math.max(0, n) : 1;
  });
  const hasPositive = rawWeights.some((w) => w > 0);
  const participants = hasPositive ? active.filter((_, i) => rawWeights[i] > 0) : active.slice();
  const weights = hasPositive ? rawWeights.filter((w) => w > 0) : active.map(() => 1);
  const weightSum = weights.reduce((a, w) => a + w, 0);

  participants.forEach((s, i) => {
    let n = Math.floor((total * weights[i]) / weightSum);
    if (s.quota !== undefined) n = Math.min(n, s.quota);
    alloc[s.connectionId] = n;
  });

  let remaining = total - participants.reduce((a, s) => a + alloc[s.connectionId], 0);
  let i = 0;
  let guard = 0;
  while (remaining > 0 && guard < total * participants.length + participants.length) {
    const s = participants[i % participants.length];
    const cap = s.quota ?? Number.POSITIVE_INFINITY;
    if (alloc[s.connectionId] < cap) {
      alloc[s.connectionId] += 1;
      remaining -= 1;
    }
    i += 1;
    guard += 1;
  }
  return alloc;
}

/** Assign emails to senders round-robin, bounded by each sender's allocation. */
export function allocateEmails(emails: string[], senders: CampaignSender[]): Record<string, string[]> {
  const alloc = computeAllocation(emails.length, senders);
  const order = senders.filter((s) => s.enabled && (alloc[s.connectionId] ?? 0) > 0);
  const out: Record<string, string[]> = {};
  order.forEach((s) => {
    out[s.connectionId] = [];
  });
  if (!order.length) return out;

  let cursor = 0;
  for (const email of emails) {
    for (let tries = 0; tries < order.length; tries += 1) {
      const s = order[cursor % order.length];
      cursor += 1;
      if (out[s.connectionId].length < (alloc[s.connectionId] ?? 0)) {
        out[s.connectionId].push(email);
        break;
      }
    }
  }
  return out;
}

export function addDays(iso: string, n: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(t)) return iso;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

export interface PlannerDay {
  day: number;
  date: string;
  perSender: Record<string, number>;
  total: number;
  cumulative: number;
}

export interface SchedulePlan {
  days: PlannerDay[];
  finishDate: string | null;
  totalDays: number;
  /** People the allocation places across accounts, after each account's quota. */
  assigned: number;
  /** People left over because every account reached its quota. */
  unassigned: number;
  /** People the day-by-day plan actually schedules within `maxDays`. */
  scheduled: number;
  /** Still unscheduled when the planner stops — quotas, pauses or `maxDays`. */
  remaining: number;
}

/**
 * Day-by-day estimate of how long `total` takes given each sender's cap/ramp.
 *
 * When `allocation` is supplied, each account may only send the number of people assigned to it.
 * That keeps the estimate honest: a 90%-share account with a low daily cap cannot be bailed out by
 * an account that was assigned only 10%, because the queues really are separate.
 */
export function planSchedule(params: {
  total: number;
  senders: Array<{ connectionId: string; profile: SenderProfile }>;
  startDate: string;
  maxDays?: number;
  allocation?: Record<string, number>;
}): SchedulePlan {
  const maxDays = params.maxDays ?? 90;
  const days: PlannerDay[] = [];
  const hasAllocation = params.allocation !== undefined;
  const assigned = hasAllocation
    ? params.senders.reduce(
        (sum, s) => sum + Math.max(0, params.allocation?.[s.connectionId] ?? 0),
        0,
      )
    : params.total;
  const planned = Math.min(params.total, assigned);
  const sentBySender: Record<string, number> = {};
  if (hasAllocation) {
    params.senders.forEach((s) => {
      sentBySender[s.connectionId] = 0;
    });
  }

  let remaining = planned;
  let cumulative = 0;

  for (let d = 0; d < maxDays && remaining > 0; d += 1) {
    const date = addDays(params.startDate, d);
    const perSender: Record<string, number> = {};
    let dayTotal = 0;

    for (const s of params.senders) {
      if (s.profile.enabled === false) continue;
      const cap = dailyCapFor(s.profile, date);
      let available = remaining - dayTotal;
      if (hasAllocation) {
        const target = Math.max(0, params.allocation?.[s.connectionId] ?? 0);
        available = Math.min(available, target - (sentBySender[s.connectionId] ?? 0));
      }
      const take = Math.min(cap, available);
      if (take > 0) {
        perSender[s.connectionId] = take;
        dayTotal += take;
        if (hasAllocation) sentBySender[s.connectionId] += take;
      }
    }

    if (dayTotal <= 0) break;
    remaining -= dayTotal;
    cumulative += dayTotal;
    days.push({ day: d + 1, date, perSender, total: dayTotal, cumulative });
  }

  return {
    days,
    finishDate: days.length ? days[days.length - 1].date : null,
    totalDays: days.length,
    assigned: planned,
    unassigned: Math.max(0, params.total - planned),
    scheduled: cumulative,
    remaining: Math.max(0, params.total - cumulative),
  };
}

/**
 * How many people the plan reaches before a deadline.
 *
 * Compares whole day *ends* against the timestamp rather than formatting dates into strings: the old
 * `toISOString().slice(0, 10)` comparison put a deadline late in the local evening on the next UTC
 * day, which made the "your stop time cuts people off" warning wrong by a day.
 */
export function invitedByDeadline(plan: { days: PlannerDay[] }, sendByAt: number): number {
  if (!Number.isFinite(sendByAt)) return 0;

  let invited = 0;
  for (const day of plan.days) {
    const dayEnd = Date.parse(`${day.date}T00:00:00Z`) + 86400000;
    if (Number.isNaN(dayEnd)) continue;
    if (dayEnd > sendByAt) break;
    invited = day.cumulative;
  }
  return invited;
}
