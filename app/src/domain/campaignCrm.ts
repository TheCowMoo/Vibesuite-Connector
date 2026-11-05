import { normalizeEmail, type AttendancePerson, type AttendanceReport } from './attendance';
import type { Campaign, RecipientRecord } from './campaign';
import { crmPersonKey, type CampaignCrmNote, type FollowUpStatus } from './campaignNotes';
import { normalizeRsvp, type RsvpStatus } from './campaignStats';
import { variantRank } from './campaignVariants';
import type { RsvpHistoryEntry } from './rsvpHistory';
import type { ZoomBehavior } from './zoomBehavior';

export type CrmSendStatus = 'sent' | 'pending' | 'failed' | 'walk_in';
export type CrmZoomResult =
  | 'attended'
  | 'partial'
  | 'didnt_join'
  | 'walk_in'
  | 'not_tracked'
  | 'not_invited';
export type CrmRsvp = RsvpStatus | 'none';

export interface CampaignCrmProfile {
  name?: string;
  company?: string;
  phone?: string;
}

export interface CampaignCrmRow {
  key: string;
  email?: string;
  name?: string;
  company?: string;
  phone?: string;
  walkIn: boolean;
  connectionId?: string;
  senderName?: string;
  variant?: string;
  sendStatus: CrmSendStatus;
  sentAt?: number;
  eventId?: string;
  sendError?: string;
  rsvp: CrmRsvp;
  rsvpHistory: RsvpHistoryEntry[];
  zoom: CrmZoomResult;
  joinedAt?: string;
  leftAt?: string;
  durationSec?: number;
  attentivenessScore?: number;
  behavior?: ZoomBehavior;
  note?: CampaignCrmNote;
}

export interface CampaignCrmSummary {
  people: number;
  sent: number;
  pending: number;
  failed: number;
  rsvp: { accepted: number; declined: number; tentative: number; noReply: number; none: number };
  zoom: {
    attended: number;
    partial: number;
    didntJoin: number;
    walkIns: number;
    notTracked: number;
    notInvited: number;
  };
  yesButDidntJoin: number;
  followUp: { none: number; todo: number; contacted: number; done: number; open: number };
}

export interface CampaignCrmFilterOptions {
  senders: Array<{ connectionId: string; name: string }>;
  variants: string[];
}

export interface CampaignCrmQuery {
  q?: string;
  rsvp?: string;
  zoom?: string;
  send?: string;
  sender?: string;
  variant?: string;
  followUp?: string;
  sort?: string;
  offset?: number;
  limit?: number;
}

export interface CampaignCrmBuildInput {
  campaign: Campaign;
  recipients: RecipientRecord[];
  /** connectionId -> eventId -> email -> Google responseStatus. */
  rsvpByConnection: Record<string, Record<string, Record<string, string>>>;
  attendance?: AttendanceReport | null;
  profiles?: Record<string, CampaignCrmProfile>;
  notes?: Record<string, CampaignCrmNote>;
  /** `${connectionId}|${eventId}` -> email -> history. */
  history?: Record<string, Record<string, RsvpHistoryEntry[]>>;
  connectionNames?: Record<string, string>;
}

export interface CampaignCrmBuildResult {
  rows: CampaignCrmRow[];
  summary: CampaignCrmSummary;
  filters: CampaignCrmFilterOptions;
  warnings: string[];
  hasAttendance: boolean;
  attendanceGeneratedAt?: number;
}

function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  return s || undefined;
}

function phone(value: unknown): string | undefined {
  if (Array.isArray(value)) return text(value[0]);
  return text(value);
}

function historyKey(connectionId: string, eventId: string): string {
  return `${connectionId}|${eventId}`;
}

/**
 * Best-effort names/company/phone from the source list's arbitrary rows. The frozen recipient
 * record only has an email, and the list may have changed since the send, so this is enrichment
 * rather than a source of truth.
 */
export function profilesFromList(result: unknown, segmentNames?: string[]): Record<string, CampaignCrmProfile> {
  const segments = Array.isArray((result as { segments?: unknown })?.segments)
    ? ((result as { segments: Array<{ name?: string; rows?: unknown[] }> }).segments)
    : [];
  const selected = segmentNames && segmentNames.length
    ? segments.filter((segment) => segmentNames.includes(String(segment.name ?? '')))
    : segments;

  const out: Record<string, CampaignCrmProfile> = {};
  const add = (email: string | undefined, profile: CampaignCrmProfile): void => {
    if (!email || !email.includes('@')) return;
    const key = normalizeEmail(email);
    if (!key) return;
    const existing = out[key];
    out[key] = {
      name: existing?.name || profile.name,
      company: existing?.company || profile.company,
      phone: existing?.phone || profile.phone,
    };
  };

  for (const segment of selected) {
    for (const row of segment.rows ?? []) {
      if (typeof row === 'string') {
        const emailMatch = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(row);
        if (!emailMatch) continue;
        const email = emailMatch[0];
        const before = row.slice(0, emailMatch.index).replace(/[<(",]+$/g, '').trim();
        add(email, { name: before && before.length <= 120 ? before : undefined });
        continue;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;

      const values = row as Record<string, unknown>;
      const keys = Object.keys(values);
      const emailKey = keys.find((key) => /e-?mail/i.test(key));
      if (!emailKey) continue;
      const email = text(values[emailKey]);
      if (!email) continue;

      const nameKey = keys.find((key) => /^(full[ _-]?name|name|contact[ _-]?name|attendee)$/i.test(key));
      const first = keys.find((key) => /^(first[ _-]?name|given[ _-]?name)$/i.test(key));
      const last = keys.find((key) => /^(last[ _-]?name|surname|family[ _-]?name)$/i.test(key));
      const companyKey = keys.find((key) => /(company|organization|\borg\b)/i.test(key));
      const phoneKey = keys.find((key) => /(phone|mobile|\btel\b)/i.test(key));

      const combinedName = [first ? text(values[first]) : '', last ? text(values[last]) : '']
        .filter(Boolean)
        .join(' ')
        .trim();

      add(email, {
        name: (nameKey ? text(values[nameKey]) : undefined) || combinedName || undefined,
        company: companyKey ? text(values[companyKey]) : undefined,
        phone: phoneKey ? phone(values[phoneKey]) : undefined,
      });
    }
  }
  return out;
}

function emptySummary(): CampaignCrmSummary {
  return {
    people: 0,
    sent: 0,
    pending: 0,
    failed: 0,
    rsvp: { accepted: 0, declined: 0, tentative: 0, noReply: 0, none: 0 },
    zoom: { attended: 0, partial: 0, didntJoin: 0, walkIns: 0, notTracked: 0, notInvited: 0 },
    yesButDidntJoin: 0,
    followUp: { none: 0, todo: 0, contacted: 0, done: 0, open: 0 },
  };
}

export function buildCampaignCrm(input: CampaignCrmBuildInput): CampaignCrmBuildResult {
  const attendance = input.attendance ?? null;
  const notes = input.notes ?? {};
  const profiles = input.profiles ?? {};
  const history = input.history ?? {};
  const connectionNames = input.connectionNames ?? {};

  const attendedByEmail = new Map<string, AttendancePerson>();
  const noShow = new Set<string>();
  for (const person of attendance?.attended ?? []) {
    const email = person.email ? normalizeEmail(person.email) : '';
    if (email) attendedByEmail.set(email, person);
  }
  for (const email of attendance?.noShow ?? []) {
    const normalized = normalizeEmail(email);
    if (normalized) noShow.add(normalized);
  }

  const rows: CampaignCrmRow[] = [];
  const seenRecipients = new Set<string>();

  input.recipients.forEach((rec, index) => {
    const email = rec.email ? normalizeEmail(rec.email) : '';
    if (email && seenRecipients.has(email)) return;
    if (email) seenRecipients.add(email);

    const key = email || `recipient:${rec.connectionId}:${index}`;
    const profile = email ? profiles[email] : undefined;
    const person = email ? attendedByEmail.get(email) : undefined;

    let zoom: CrmZoomResult;
    if (rec.status !== 'sent') zoom = 'not_invited';
    else if (!attendance) zoom = 'not_tracked';
    else if (person) zoom = person.status === 'partial' ? 'partial' : 'attended';
    else if (email && noShow.has(email)) zoom = 'didnt_join';
    else zoom = 'not_tracked';

    const rsvp: CrmRsvp = rec.status === 'sent'
      ? normalizeRsvp(input.rsvpByConnection[rec.connectionId]?.[rec.eventId ?? '']?.[email])
      : 'none';
    const historyEntries = rec.eventId
      ? history[historyKey(rec.connectionId, rec.eventId)]?.[email] ?? []
      : [];

    rows.push({
      key,
      email: email || undefined,
      name: person?.name || profile?.name,
      company: profile?.company,
      phone: profile?.phone,
      walkIn: false,
      connectionId: rec.connectionId,
      senderName: connectionNames[rec.connectionId] || rec.connectionId.slice(0, 8),
      variant: rec.variant,
      sendStatus: rec.status,
      sentAt: rec.sentAt,
      eventId: rec.eventId,
      sendError: rec.error,
      rsvp,
      rsvpHistory: historyEntries,
      zoom,
      joinedAt: person?.joinedAt,
      leftAt: person?.leftAt,
      durationSec: person?.durationSec,
      attentivenessScore: person?.attentivenessScore,
      behavior: person?.behavior,
      note: notes[key],
    });
  });

  const usedKeys = new Set(rows.map((row) => row.key));
  let noEmailWalkIns = 0;
  (attendance?.attendedNotInvited ?? []).forEach((person, index) => {
    const email = person.email ? normalizeEmail(person.email) : '';
    if (email && seenRecipients.has(email)) return;
    let key = crmPersonKey(email, person.name) || `walkin:${index}`;
    if (usedKeys.has(key)) key = `${key}:${index}`;
    usedKeys.add(key);
    if (!email) noEmailWalkIns += 1;

    const profile = email ? profiles[email] : undefined;
    rows.push({
      key,
      email: email || undefined,
      name: person.name || profile?.name || email || undefined,
      company: profile?.company,
      phone: profile?.phone,
      walkIn: true,
      connectionId: undefined,
      senderName: 'Walk-in',
      variant: undefined,
      sendStatus: 'walk_in',
      sentAt: undefined,
      eventId: undefined,
      sendError: undefined,
      rsvp: 'none',
      rsvpHistory: [],
      zoom: 'walk_in',
      joinedAt: person.joinedAt,
      leftAt: person.leftAt,
      durationSec: person.durationSec,
      attentivenessScore: person.attentivenessScore,
      behavior: person.behavior,
      note: notes[key],
    });
  });

  const summary = emptySummary();
  let lastSentAt: number | undefined;
  let matchedCount = 0;

  for (const row of rows) {
    const followUp: FollowUpStatus = row.note?.followUp ?? 'none';
    summary.followUp[followUp] += 1;

    if (row.walkIn) {
      summary.zoom.walkIns += 1;
      continue;
    }

    summary.people += 1;
    if (row.sendStatus === 'sent') {
      summary.sent += 1;
      if (row.sentAt !== undefined && (lastSentAt === undefined || row.sentAt > lastSentAt)) {
        lastSentAt = row.sentAt;
      }
    } else if (row.sendStatus === 'failed') {
      summary.failed += 1;
    } else {
      summary.pending += 1;
    }

    switch (row.rsvp) {
      case 'accepted':
        summary.rsvp.accepted += 1;
        break;
      case 'declined':
        summary.rsvp.declined += 1;
        break;
      case 'tentative':
        summary.rsvp.tentative += 1;
        break;
      case 'needsAction':
        summary.rsvp.noReply += 1;
        break;
      default:
        summary.rsvp.none += 1;
    }

    switch (row.zoom) {
      case 'attended':
        summary.zoom.attended += 1;
        matchedCount += 1;
        break;
      case 'partial':
        summary.zoom.partial += 1;
        matchedCount += 1;
        break;
      case 'didnt_join':
        summary.zoom.didntJoin += 1;
        matchedCount += 1;
        break;
      case 'not_invited':
        summary.zoom.notInvited += 1;
        break;
      default:
        summary.zoom.notTracked += 1;
    }

    if ((row.rsvp === 'accepted' || row.rsvp === 'tentative') && row.zoom === 'didnt_join') {
      summary.yesButDidntJoin += 1;
    }
  }
  summary.followUp.open = summary.followUp.todo + summary.followUp.contacted;

  const senderIds = Array.from(
    new Set([
      ...input.campaign.senders.map((sender) => sender.connectionId),
      ...rows
        .filter((row) => !row.walkIn && row.connectionId)
        .map((row) => String(row.connectionId)),
    ]),
  );
  const variants = Array.from(
    new Set(
      rows
        .filter((row) => !row.walkIn && row.variant)
        .map((row) => String(row.variant)),
    ),
  ).sort((a, b) => variantRank(a) - variantRank(b) || a.localeCompare(b));

  const filters: CampaignCrmFilterOptions = {
    senders: senderIds
      .map((connectionId) => ({ connectionId, name: connectionNames[connectionId] || connectionId.slice(0, 8) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    variants,
  };

  const warnings = campaignCrmWarnings({
    sessionLinked: !!input.campaign.sessionId,
    hasAttendance: !!attendance,
    attendanceGeneratedAt: attendance?.generatedAt,
    lastSentAt,
    sentCount: summary.sent,
    matchedCount,
    noEmailWalkIns,
    walkInCount: summary.zoom.walkIns,
  });

  return {
    rows,
    summary,
    filters,
    warnings,
    hasAttendance: !!attendance,
    ...(attendance?.generatedAt ? { attendanceGeneratedAt: attendance.generatedAt } : {}),
  };
}

export interface CampaignCrmWarningInput {
  sessionLinked: boolean;
  hasAttendance: boolean;
  attendanceGeneratedAt?: number;
  lastSentAt?: number;
  sentCount: number;
  matchedCount: number;
  noEmailWalkIns: number;
  walkInCount: number;
}

export function campaignCrmWarnings(input: CampaignCrmWarningInput): string[] {
  const warnings: string[] = [];
  if (!input.sessionLinked) {
    warnings.push('No call is linked to this campaign, so Zoom attendance is not available.');
    return warnings;
  }
  if (!input.hasAttendance) {
    warnings.push('The linked call has no Zoom report yet. Sync the call to see attendance.');
    return warnings;
  }
  if (
    input.attendanceGeneratedAt !== undefined &&
    input.lastSentAt !== undefined &&
    input.attendanceGeneratedAt < input.lastSentAt
  ) {
    warnings.push('Zoom results were synced before the latest invitations went out. Sync the call again to match late invites.');
  }
  if (input.sentCount > 0 && input.matchedCount < input.sentCount) {
    warnings.push(`Zoom's report covers ${input.matchedCount} of ${input.sentCount} invited people. Sync the call again to complete the match.`);
  }
  if (input.noEmailWalkIns > 0) {
    warnings.push(
      `${input.noEmailWalkIns} walk-in${input.noEmailWalkIns === 1 ? '' : 's'} had no email address and ${input.noEmailWalkIns === 1 ? 'is' : 'are'} shown by name only.`,
    );
  }
  if (input.walkInCount > 0) {
    warnings.push(
      `${input.walkInCount} walk-in${input.walkInCount === 1 ? '' : 's'} joined without being on this campaign's list.`,
    );
  }
  return warnings;
}

const RSVP_SORT_ORDER: Record<string, number> = {
  accepted: 0,
  tentative: 1,
  declined: 2,
  needsAction: 3,
  none: 4,
};

const ZOOM_SORT_ORDER: Record<string, number> = {
  attended: 0,
  partial: 1,
  didnt_join: 2,
  walk_in: 3,
  not_tracked: 4,
  not_invited: 5,
};

export function filterCampaignCrmRows(rows: CampaignCrmRow[], query: CampaignCrmQuery): CampaignCrmRow[] {
  const q = String(query.q ?? '').trim().toLowerCase();

  const filtered = rows.filter((row) => {
    if (q) {
      const haystack = [row.name, row.email, row.company, row.phone, row.key].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (query.rsvp) {
      if (query.rsvp === 'no_reply' ? row.rsvp !== 'needsAction' : row.rsvp !== query.rsvp) return false;
    }
    if (query.zoom && row.zoom !== query.zoom) return false;
    if (query.send && row.sendStatus !== query.send) return false;
    if (query.sender && row.connectionId !== query.sender) return false;
    if (query.variant && row.variant !== query.variant) return false;
    if (query.followUp && (row.note?.followUp ?? 'none') !== query.followUp) return false;
    return true;
  });

  const sort = query.sort || 'name';
  filtered.sort((a, b) => {
    if (sort === 'rsvp') {
      const diff = (RSVP_SORT_ORDER[a.rsvp] ?? 9) - (RSVP_SORT_ORDER[b.rsvp] ?? 9);
      if (diff) return diff;
    } else if (sort === 'zoom') {
      const diff = (ZOOM_SORT_ORDER[a.zoom] ?? 9) - (ZOOM_SORT_ORDER[b.zoom] ?? 9);
      if (diff) return diff;
    } else if (sort === 'sent') {
      const diff = (b.sentAt ?? 0) - (a.sentAt ?? 0);
      if (diff) return diff;
    }
    const an = String(a.name || a.email || a.key).toLowerCase();
    const bn = String(b.name || b.email || b.key).toLowerCase();
    return an.localeCompare(bn);
  });
  return filtered;
}

export function selectCampaignCrmRows(
  rows: CampaignCrmRow[],
  query: CampaignCrmQuery,
): { rows: CampaignCrmRow[]; total: number; offset: number; limit: number } {
  const filtered = filterCampaignCrmRows(rows, query);
  const rawOffset = Number(query.offset ?? 0);
  const rawLimit = Number(query.limit ?? 50);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
  return {
    rows: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
  };
}
