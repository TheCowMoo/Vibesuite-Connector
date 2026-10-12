export interface MailboxSnapshot {
  label: string;
  enabled: boolean;
  mode: string;
  dailyCap: number;
  hourlyCap?: number;
  minDelayMs?: number;
  window: { startHour: number; endHour: number; days: number[]; timeZone: string };
  ramp?: { startDailyCap: number; incrementPerDay: number; maxDailyCap: number; startDate: string };
  capToday: number;
  sentToday: number;
  failedToday: number;
  sentThisHour: number;
  errorStreak: number;
  cooling: boolean;
  cooldownUntil?: number;
  history: Array<{ date: string; sent: number; failed: number }>;
}

export interface CampaignSnapshot {
  label: string;
  status: string;
  spread: string;
  mailboxes: number;
  invited: number;
  queued: number;
  sent: number;
  failed: number;
  accepted: number;
  declined: number;
  tentative: number;
  noResponse: number;
  attended: number;
  noShow: number;
  rsvpRate: number;
  acceptanceRate: number;
  attendanceRate: number;
  hasAttendance: boolean;
}

export interface AdvisorSnapshot {
  generatedAt: number;
  settings: {
    tickIntervalMs: number;
    defaultDailyCap: number;
    defaultHourlyCap: number;
    defaultMinDelayMs: number;
    cooldownOnErrors: number;
    cooldownHours: number;
  };
  mailboxes: MailboxSnapshot[];
  campaigns: CampaignSnapshot[];
}

export function mailboxLabel(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Mailbox ${out}`;
}

export function campaignLabel(index: number): string {
  return `Campaign ${Math.max(0, Math.floor(index)) + 1}`;
}

/**
 * The auditable answer to "what exactly did we send the model?".
 * Rendered in the Advisor tab next to the analysis.
 */
export const SNAPSHOT_APPENDIX: Array<{ field: string; included: boolean; note: string }> = [
  { field: 'Mailbox load settings (cap, hourly, delay, ramp, window, timezone)', included: true, note: 'Required to judge capacity and pacing.' },
  { field: 'Mailbox counters (sent today, this hour, failures, error streak, cooldown)', included: true, note: 'Aggregate counts only.' },
  { field: '14-day per-mailbox send/fail history', included: true, note: 'Daily totals; no per-recipient rows.' },
  { field: 'Campaign funnel totals and rates', included: true, note: 'Aggregated per campaign.' },
  { field: 'Mailbox identity (address, display name, domain)', included: false, note: 'Replaced by Mailbox A/B/C labels.' },
  { field: 'Campaign, list and session names; event titles and descriptions', included: false, note: 'Replaced by Campaign 1/2/3 labels; marketing copy is never sent.' },
  { field: 'Recipient emails, names, phone numbers, per-person RSVP status', included: false, note: 'Never leaves the server.' },
  { field: 'List contents and segmentation results', included: false, note: 'Never leaves the server.' },
  { field: 'OAuth tokens, API keys, session tokens', included: false, note: 'Never leaves the server.' },
];
