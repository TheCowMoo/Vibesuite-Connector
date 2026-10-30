import { createInviteEvent } from '../google/events';
import { chunk } from './invite';
import { markInvited, type InviteBatch, type InviteSenderSummary } from './inviteStore';
import { bumpSenderDay, bumpSenderHour, isoHour } from './senderStore';
import { isoDate } from './senderLoad';
import { getConnection } from './connectionStore';
import type { AccountCapacity } from './inviteCapacity';
import { withRetry, sleep } from '../lib/backoff';
import { env } from '../config/env';
import { logger } from '../lib/logger';

export interface InviteEventPayload {
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
}

export interface InviteRoundInput {
  listId: string;
  event: InviteEventPayload;
  /** connectionId -> emails assigned to that account for this round. */
  allocation: Record<string, string[]>;
  accounts: AccountCapacity[];
  /**
   * When greater than zero, each account gets exactly one event with at most this many recipients.
   * Zero/undefined keeps the legacy behaviour: chunk by `INVITE_BATCH_SIZE` with numbered suffixes.
   */
  batchSize?: number;
  now: Date;
}

export interface InviteRoundResult {
  batches: InviteBatch[];
  senders: InviteSenderSummary[];
  sentEmails: string[];
  failedEmails: string[];
  firstError?: string;
}

function describeError(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } | string } }; message?: string };
  const status = e?.response?.status;
  const d = e?.response?.data?.error;
  const detail = typeof d === 'string' ? d : d?.message;
  const base = detail || e?.message || 'unknown error';
  return status ? `${status} ${base}` : base;
}

/**
 * Send one round of invitations and mark the successful recipients as invited.
 *
 * Legacy mode (no `batchSize`) is the original per-account chunking, including the `(1/3)` suffix
 * when one account's slice needs splitting. Batched mode creates one event per account, capped at
 * `batchSize`, so a round means "one event per account" — the whole point of the scheduled batches.
 */
export async function sendInviteRound(input: InviteRoundInput): Promise<InviteRoundResult> {
  const { allocation, accounts, event: ev, batchSize } = input;
  const batches: InviteBatch[] = [];
  const senders: InviteSenderSummary[] = [];
  const sentEmails: string[] = [];
  const failedEmails: string[] = [];
  let firstError = '';

  for (const account of accounts) {
    const slice = allocation[account.connectionId] || [];
    const row: InviteSenderSummary = {
      connectionId: account.connectionId,
      connectionName: account.name,
      sent: 0,
      failed: 0,
      skippedReason: account.reason,
    };
    senders.push(row);
    if (!slice.length) continue;

    const conn = await getConnection(account.connectionId);
    if (!conn) {
      row.skippedReason = 'account not found';
      // Keep these for the next scheduled round instead of silently dropping them.
      failedEmails.push(...slice);
      row.failed += slice.length;
      continue;
    }

    // Batched: exactly one event per account. Legacy: chunk per mailbox so the normal case
    // (one chunk per account) never shows a numbered suffix to a guest.
    const groups = batchSize && batchSize > 0 ? [slice.slice(0, batchSize)] : chunk(slice, env.INVITE_BATCH_SIZE);

    for (let i = 0; i < groups.length; i++) {
      const part = groups[i];
      if (!part.length) continue;
      const summary = groups.length > 1 ? `${ev.summary} (${i + 1}/${groups.length})` : ev.summary;
      try {
        const res = await withRetry(() => createInviteEvent(conn, { ...ev, summary, emails: part }), { retries: 3 });
        batches.push({
          chunk: batches.length + 1,
          connectionId: conn.id,
          eventId: res.id,
          htmlLink: res.htmlLink,
          count: part.length,
        });
        sentEmails.push(...part);
        row.sent += part.length;
        await bumpSenderDay(conn.id, isoDate(input.now), 'sent', part.length);
        await bumpSenderHour(conn.id, isoHour(input.now), part.length);
      } catch (err) {
        const msg = describeError(err);
        firstError = firstError || msg;
        failedEmails.push(...part);
        row.failed += part.length;
        await bumpSenderDay(conn.id, isoDate(input.now), 'failed', part.length);
        logger.error({ connectionId: conn.id, listId: input.listId, chunk: i + 1, err: msg }, 'invite chunk failed');
      }
      if (i < groups.length - 1) await sleep(env.INVITE_DELAY_MS);
    }

    // Small gap between mailboxes so several accounts never hit Google in lockstep.
    await sleep(env.INVITE_DELAY_MS);
  }

  if (sentEmails.length) {
    await markInvited(input.listId, sentEmails, {
      summary: ev.summary,
      start: ev.start,
      source: 'invite',
    });
  }

  return { batches, senders, sentEmails, failedEmails, firstError: firstError || undefined };
}
