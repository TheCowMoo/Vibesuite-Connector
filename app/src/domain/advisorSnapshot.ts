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
  return `Account ${out}`;
}

export function campaignLabel(index: number): string {
  return `Campaign ${Math.max(0, Math.floor(index)) + 1}`;
}

/**
 * The auditable answer to "what exactly did we send the model?".
 * Rendered in the Advisor tab next to the analysis.
 */
export const SNAPSHOT_APPENDIX: Array<{ field: string; included: boolean; note: string }> = [
  { field: 'How much each account is allowed to send (limits, warm-up, sending hours)', included: true, note: 'Needed to judge how much more you can send.' },
  { field: "Today's totals per account (sent, this hour, failures, whether it is resting)", included: true, note: 'Totals only — nothing per person.' },
  { field: 'The last 14 days of daily send and failure totals per account', included: true, note: 'Daily totals; nothing per person.' },
  { field: 'Campaign totals and reply rates', included: true, note: 'Totals per campaign.' },
  { field: 'Account identity (email address, display name, domain)', included: false, note: 'Replaced with "Account A", "Account B", and so on.' },
  { field: 'Campaign, contact list and video call names; event titles and text', included: false, note: 'Replaced with "Campaign 1", "Campaign 2"; your own wording is never sent.' },
  { field: "People's emails, names, phone numbers, or individual replies", included: false, note: 'Never leaves your server.' },
  { field: 'What is inside your contact lists and how they were grouped', included: false, note: 'Never leaves your server.' },
  { field: 'Passwords, API keys, and login tokens', included: false, note: 'Never leaves your server.' },
];
