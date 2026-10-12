import { z } from 'zod';

export type SenderMode = 'flat' | 'ramp';

export const SenderWindowSchema = z.object({
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
  timeZone: z.string().min(1).default('UTC'),
});

export const SenderRampSchema = z.object({
  startDailyCap: z.number().int().min(1).max(5000),
  incrementPerDay: z.number().int().min(0).max(5000),
  maxDailyCap: z.number().int().min(1).max(5000),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const SenderProfileSchema = z.object({
  connectionId: z.string().min(1),
  enabled: z.boolean().default(true),
  mode: z.enum(['flat', 'ramp']).default('flat'),
  dailyCap: z.number().int().min(1).max(5000),
  hourlyCap: z.number().int().min(1).max(1000).optional(),
  minDelayMs: z.number().int().min(0).max(600000).optional(),
  ramp: SenderRampSchema.optional(),
  window: SenderWindowSchema,
});

export type SenderWindow = z.infer<typeof SenderWindowSchema>;
export type SenderRamp = z.infer<typeof SenderRampSchema>;
export type SenderProfile = z.infer<typeof SenderProfileSchema>;

export interface SenderState {
  lastSentAt?: number;
  errorStreak: number;
  cooldownUntil?: number;
  lastError?: string;
}

export const DEFAULT_WINDOW: SenderWindow = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5], timeZone: 'UTC' };

export function isoDate(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (never negative). */
export function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T00:00:00Z`);
  const b = Date.parse(`${toISO}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.floor((b - a) / 86400000));
}

/** Day 1 = startDate; grows by incrementPerDay, capped at maxDailyCap. */
export function rampCapForDay(ramp: SenderRamp, dayIndex: number): number {
  const raw = ramp.startDailyCap + Math.max(0, dayIndex - 1) * ramp.incrementPerDay;
  return Math.min(raw, ramp.maxDailyCap);
}

export function rampDayIndex(profile: SenderProfile, todayISO: string): number {
  if (profile.mode !== 'ramp' || !profile.ramp) return 0;
  return daysBetween(profile.ramp.startDate, todayISO) + 1;
}

/** The cap that actually applies today — the ramp cap can never exceed dailyCap. */
export function dailyCapFor(profile: SenderProfile, todayISO: string): number {
  if (profile.mode === 'ramp' && profile.ramp) {
    return Math.min(rampCapForDay(profile.ramp, rampDayIndex(profile, todayISO)), profile.dailyCap);
  }
  return profile.dailyCap;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Local hour + weekday in the profile's timezone (Node's built-in ICU — no new deps). */
export function localParts(timeZone: string, at: Date): { hour: number; weekday: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    return { hour, weekday: WEEKDAY_INDEX[wd] ?? 1 };
  } catch {
    return { hour: at.getUTCHours(), weekday: at.getUTCDay() };
  }
}

export function isWithinWindow(win: SenderWindow, at: Date): boolean {
  const { hour, weekday } = localParts(win.timeZone, at);
  if (win.days.length > 0 && !win.days.includes(weekday)) return false;
  if (win.startHour === win.endHour) return true;
  if (win.startHour < win.endHour) return hour >= win.startHour && hour < win.endHour;
  return hour >= win.startHour || hour < win.endHour; // wraps past midnight
}
