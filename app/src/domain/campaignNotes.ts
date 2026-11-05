import { normalizeEmail } from './attendance';

export const FOLLOW_UP_STATUSES = ['none', 'todo', 'contacted', 'done'] as const;
export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export interface CampaignCrmNote {
  followUp: FollowUpStatus;
  note: string;
  updatedAt?: number;
  updatedBy?: string;
}

export const NOTE_MAX_LENGTH = 2000;

export function defaultCampaignCrmNote(): CampaignCrmNote {
  return { followUp: 'none', note: '' };
}

export function normalizeFollowUp(value: unknown): FollowUpStatus | null {
  return typeof value === 'string' && (FOLLOW_UP_STATUSES as readonly string[]).includes(value)
    ? (value as FollowUpStatus)
    : null;
}

/** `null` means invalid (too long or not a string); an empty string is a valid cleared note. */
export function normalizeNote(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const note = value.trim();
  return note.length <= NOTE_MAX_LENGTH ? note : null;
}

/**
 * Stable key for campaign-scoped notes. Recipients use their email; walk-ins without one fall
 * back to their normalized name so an operator can still annotate them.
 */
export function crmPersonKey(email?: string, name?: string): string | null {
  const normalizedEmail = typeof email === 'string' ? normalizeEmail(email) : '';
  if (normalizedEmail && normalizedEmail.includes('@')) return normalizedEmail;
  const normalizedName = typeof name === 'string' ? name.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  return normalizedName ? `walkin:${normalizedName}` : null;
}
