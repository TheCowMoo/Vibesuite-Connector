import { normalizeEmail } from './attendance';
import type { RecipientRecord } from './campaign';

export const RSVP_STATUSES = ['accepted', 'declined', 'tentative', 'needsAction'] as const;
export type RsvpStatus = (typeof RSVP_STATUSES)[number];

export interface CampaignFunnel {
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
  /** Percentages (0–100, one decimal). */
  rsvpRate: number;
  acceptanceRate: number;
  attendanceRate: number;
}

export interface SenderAttribution {
  connectionId: string;
  invited: number;
  sent: number;
  failed: number;
  accepted: number;
  declined: number;
  tentative: number;
  noResponse: number;
  attended: number;
  noShow: number;
}

export interface VariantAttribution extends CampaignFunnel {
  variant: string;
}

export interface CampaignStats {
  funnel: CampaignFunnel;
  perSender: SenderAttribution[];
  /** One row per copy variant that appears in the recipient set. Empty for an empty campaign. */
  variants: VariantAttribution[];
  hasAttendance: boolean;
}

export interface StatsInput {
  recipients: RecipientRecord[];
  /** connectionId -> eventId -> email -> Google `responseStatus`. */
  rsvpByConnection: Record<string, Record<string, Record<string, string>>>;
  /** Normalised email -> attended. Absent when the session has no report yet. */
  attendanceByEmail?: Record<string, boolean>;
}

export function normalizeRsvp(status: string | undefined): RsvpStatus {
  const s = (status ?? '').toLowerCase();
  if (s === 'accepted' || s === 'declined' || s === 'tentative') return s;
  return 'needsAction';
}

/** Percentage rounded to one decimal — real funnel numbers, never invented. */
export function percent(part: number, whole: number): number {
  if (!whole) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function emptyAttribution(connectionId: string): SenderAttribution {
  return {
    connectionId,
    invited: 0,
    sent: 0,
    failed: 0,
    accepted: 0,
    declined: 0,
    tentative: 0,
    noResponse: 0,
    attended: 0,
    noShow: 0,
  };
}

function emptyFunnel(): CampaignFunnel {
  return {
    invited: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    accepted: 0,
    declined: 0,
    tentative: 0,
    noResponse: 0,
    attended: 0,
    noShow: 0,
    rsvpRate: 0,
    acceptanceRate: 0,
    attendanceRate: 0,
  };
}

function finalizeFunnel(funnel: CampaignFunnel): void {
  const expected = funnel.accepted + funnel.tentative;
  funnel.rsvpRate = percent(funnel.accepted + funnel.declined + funnel.tentative, funnel.sent);
  funnel.acceptanceRate = percent(funnel.accepted, funnel.sent);
  funnel.attendanceRate = percent(funnel.attended, expected);
}

/**
 * Fold frozen recipients + per-mailbox RSVP state + session attendance into one
 * funnel, attributing every number back to the mailbox that actually sent it.
 */
export function buildCampaignStats(input: StatsInput): CampaignStats {
  const funnel = emptyFunnel();
  const variantFunnels = new Map<string, CampaignFunnel>();

  const perSender = new Map<string, SenderAttribution>();
  const rowFor = (connectionId: string): SenderAttribution => {
    let row = perSender.get(connectionId);
    if (!row) {
      row = emptyAttribution(connectionId);
      perSender.set(connectionId, row);
    }
    return row;
  };

  const trackingAttendance = input.attendanceByEmail !== undefined;

  for (const rec of input.recipients) {
    const email = normalizeEmail(rec.email);
    const row = rowFor(rec.connectionId);
    const variantId = rec.variant ?? 'A';
    let variant = variantFunnels.get(variantId);
    if (!variant) {
      variant = emptyFunnel();
      variantFunnels.set(variantId, variant);
    }

    funnel.invited += 1;
    variant.invited += 1;
    row.invited += 1;

    if (rec.status === 'failed') {
      funnel.failed += 1;
      variant.failed += 1;
      row.failed += 1;
      continue;
    }
    if (rec.status !== 'sent') {
      funnel.queued += 1;
      variant.queued += 1;
      continue;
    }

    funnel.sent += 1;
    variant.sent += 1;
    row.sent += 1;

    const byEvent = input.rsvpByConnection[rec.connectionId];
    const status = normalizeRsvp(byEvent && rec.eventId ? byEvent[rec.eventId]?.[email] : undefined);

    if (status === 'accepted') {
      funnel.accepted += 1;
      variant.accepted += 1;
      row.accepted += 1;
    } else if (status === 'declined') {
      funnel.declined += 1;
      variant.declined += 1;
      row.declined += 1;
    } else if (status === 'tentative') {
      funnel.tentative += 1;
      variant.tentative += 1;
      row.tentative += 1;
    } else {
      funnel.noResponse += 1;
      variant.noResponse += 1;
      row.noResponse += 1;
    }

    if (!trackingAttendance) continue;

    const attended = input.attendanceByEmail?.[email] === true;
    if (attended) {
      funnel.attended += 1;
      variant.attended += 1;
      row.attended += 1;
    } else if (status === 'accepted' || status === 'tentative') {
      funnel.noShow += 1;
      variant.noShow += 1;
      row.noShow += 1;
    }
  }

  finalizeFunnel(funnel);

  const variantOrder = ['A', 'B', 'C', 'D'];
  const variants: VariantAttribution[] = Array.from(variantFunnels.entries()).map(([variantId, values]) => {
    finalizeFunnel(values);
    return { variant: variantId, ...values };
  });
  variants.sort((a, b) => {
    const ai = variantOrder.indexOf(a.variant);
    const bi = variantOrder.indexOf(b.variant);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.variant.localeCompare(b.variant);
  });

  return {
    funnel,
    perSender: Array.from(perSender.values()).sort((a, b) => b.sent - a.sent || a.connectionId.localeCompare(b.connectionId)),
    variants,
    hasAttendance: trackingAttendance,
  };
}
