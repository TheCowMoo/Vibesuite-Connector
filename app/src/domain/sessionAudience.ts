import { normalizeEmail } from './attendance';

/** Where a call's invited set came from. */
export type InvitedSource = 'campaign' | 'invite' | 'list' | 'none';

export interface InvitedEmailInputs {
  /** Recipients actually sent by campaigns that link this call. */
  campaignEmails: string[];
  /** Recipients of the one-off invitation this call is linked to. */
  inviteEmails: string[];
  /** Whole list, when a call names a list directly. */
  listEmails: string[];
}

export interface InvitedEmails {
  emails: string[];
  source: InvitedSource;
}

/**
 * Decide who counts as invited for a call.
 *
 * Campaign recipients come first because their frozen rows are exactly what was emailed: a campaign's
 * contact list also holds people it deliberately skipped (already invited, outside the chosen groups),
 * and counting those would invent no-shows for people who never received anything. The invitation and
 * list fallbacks cover calls created from the Invitations tab.
 *
 * This lives here because the old code read `session.inviteId` only, which left every campaign-linked
 * call with an empty invited set. Zoom's participants then all landed in `attendedNotInvited`, and the
 * panel showed a flat zero even though the report had arrived.
 */
export function pickInvitedEmails(input: InvitedEmailInputs): InvitedEmails {
  const candidates: Array<[InvitedSource, string[]]> = [
    ['campaign', input.campaignEmails],
    ['invite', input.inviteEmails],
    ['list', input.listEmails],
  ];

  for (const [source, values] of candidates) {
    const emails = uniqueEmails(values);
    if (emails.length) return { emails, source };
  }

  return { emails: [], source: 'none' };
}

function uniqueEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const email = normalizeEmail(String(value ?? ''));
    // A row without an @ cannot be matched to anyone, so it must not inflate the invited count.
    if (!email || !email.includes('@') || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/**
 * Why a call has people on it but no invited list, in words an operator can act on.
 *
 * Returns `undefined` when there is nothing to explain: someone was invited, or nobody joined.
 */
export function missingAudienceNote(input: {
  invitedCount: number;
  seen: number;
  linkedCampaigns: number;
}): string | undefined {
  if (input.invitedCount > 0 || input.seen === 0) return undefined;

  if (input.linkedCampaigns > 0) {
    return 'This call is linked to a campaign that has not sent any invitations yet, so the people who joined are listed as "not on the invited list". Re-sync after the campaign starts to match them.';
  }

  return 'No invited list is linked to this call, so the people who joined are listed as "not on the invited list" and no-shows cannot be computed. Link the call to a campaign or an invitation to match them.';
}
