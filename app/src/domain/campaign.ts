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

export const CampaignSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: z.enum(['draft', 'active', 'paused', 'completed', 'scheduled', 'ended']).default('draft'),
  listId: z.string().min(1),
  segments: z.array(z.string()).default([]),
  sessionId: z.string().optional(),
  event: CampaignEventSchema,
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
  error?: string;
}

/** Split `total` across enabled senders by share/quota, redistributing the remainder. */
export function computeAllocation(total: number, senders: CampaignSender[]): Record<string, number> {
  const active = senders.filter((s) => s.enabled);
  const alloc: Record<string, number> = {};
  if (!active.length || total <= 0) return alloc;

  active.forEach((s) => {
    alloc[s.connectionId] = 0;
  });

  const weightOf = (s: CampaignSender): number => Math.max(0, s.share ?? 1);
  const weightSum = active.reduce((a, s) => a + weightOf(s), 0);

  if (weightSum > 0) {
    for (const s of active) {
      let n = Math.floor((total * weightOf(s)) / weightSum);
      if (s.quota !== undefined) n = Math.min(n, s.quota);
      alloc[s.connectionId] = n;
    }
  }

  let remaining = total - active.reduce((a, s) => a + alloc[s.connectionId], 0);
  let i = 0;
  let guard = 0;
  while (remaining > 0 && guard < total * active.length + active.length) {
    const s = active[i % active.length];
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

/** Day-by-day estimate of how long `total` takes given each sender's cap/ramp. */
export function planSchedule(params: {
  total: number;
  senders: Array<{ connectionId: string; profile: SenderProfile }>;
  startDate: string;
  maxDays?: number;
}): { days: PlannerDay[]; finishDate: string | null; totalDays: number } {
  const maxDays = params.maxDays ?? 90;
  const days: PlannerDay[] = [];
  let remaining = params.total;
  let cumulative = 0;

  for (let d = 0; d < maxDays && remaining > 0; d += 1) {
    const date = addDays(params.startDate, d);
    const perSender: Record<string, number> = {};
    let dayTotal = 0;

    for (const s of params.senders) {
      if (s.profile.enabled === false) continue;
      const cap = dailyCapFor(s.profile, date);
      const take = Math.min(cap, remaining - dayTotal);
      if (take > 0) {
        perSender[s.connectionId] = take;
        dayTotal += take;
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
  };
}
