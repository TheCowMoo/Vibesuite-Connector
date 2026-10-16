import { allocateEmails } from './campaign';

export interface AccountAllowance {
  connectionId: string;
  /** How many this mailbox may still send right now (daily and hourly headroom, whichever is lower). */
  allowance: number;
  /** Why it cannot send, or absent when it can. */
  reason?: string;
}

export interface InviteSplit {
  /** connectionId -> the emails that mailbox will send, interleaved from source order. */
  allocated: Record<string, string[]>;
  /** Emails with no headroom left anywhere right now. */
  unplaced: string[];
  totalCapacity: number;
}

/**
 * Split an audience across mailboxes, each capped at its own remaining headroom.
 *
 * `allocateEmails()` already does the hard part: it share-splits with `quota` as a hard per-sender
 * maximum, then redistributes the rounding remainder round-robin to whoever still has room. Passing
 * `quota = allowance` therefore gives "even split, but never past a mailbox's limit, and hand the
 * surplus to a mailbox that can still take it" — with nothing new to get wrong.
 *
 * Accounts with no headroom are dropped up front rather than handed an empty slice, so the caller
 * can report them as skipped instead of silently doing nothing.
 */
export function planInviteSplit(emails: string[], accounts: AccountAllowance[]): InviteSplit {
  const usable = accounts.filter((a) => a.allowance > 0);
  const totalCapacity = usable.reduce((sum, a) => sum + a.allowance, 0);

  if (!emails.length || !usable.length) {
    return { allocated: {}, unplaced: [...emails], totalCapacity };
  }

  const allocated = allocateEmails(
    emails,
    usable.map((a) => ({ connectionId: a.connectionId, enabled: true, quota: a.allowance, priority: 5 })),
  );

  const placed = new Set<string>();
  for (const list of Object.values(allocated)) for (const email of list) placed.add(email);

  return {
    allocated,
    unplaced: emails.filter((e) => !placed.has(e)),
    totalCapacity,
  };
}
