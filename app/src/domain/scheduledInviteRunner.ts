import { getInvite, getInvitedEmails, saveInvite, type InviteSenderSummary } from './inviteStore';
import {
  getScheduledInvite,
  saveScheduledInvite,
  type ScheduledInviteEvent,
  type ScheduledInviteRecord,
} from './scheduledInviteStore';
import { accountAllowances } from './inviteCapacity';
import { planInviteSplit } from './invitePlan';
import { sendInviteRound } from './inviteSend';
import { nextRoundAt } from './inviteBatches';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';

/** A failed/empty round is retried sooner than the full batch delay. */
export const SCHEDULE_RETRY_MS = 15 * 60 * 1000;

function mergeSenders(existing: InviteSenderSummary[] | undefined, incoming: InviteSenderSummary[]): InviteSenderSummary[] {
  const out: InviteSenderSummary[] = [...(existing ?? [])];
  for (const row of incoming) {
    const hit = out.find((s) => s.connectionId === row.connectionId);
    if (!hit) {
      out.push({ ...row });
      continue;
    }
    hit.sent += row.sent;
    hit.failed += row.failed;
    if (row.skippedReason && !hit.skippedReason) hit.skippedReason = row.skippedReason;
  }
  return out;
}

function finish(schedule: ScheduledInviteRecord, status: ScheduledInviteRecord['status'], error?: string): void {
  schedule.status = status;
  schedule.error = error;
  schedule.updatedAt = Date.now();
}

/**
 * Send one due round of a scheduled invitation.
 *
 * The audience is re-checked against `list:{id}:invited` (unless the schedule was created with
 * `force`), so someone invited elsewhere in the meantime is skipped. Accounts are re-read for
 * headroom at this moment; each account creates at most one event of `batchSize` recipients.
 *
 * A round where nothing could be sent is retried after `SCHEDULE_RETRY_MS` rather than waiting the
 * whole delay. A round that sent something advances by the configured delay; if the next round
 * would start at/after the event, the schedule completes and reports who was left out.
 */
export async function runScheduledInviteRound(id: string, now = Date.now()): Promise<void> {
  const schedule = await getScheduledInvite(id);
  if (!schedule || schedule.status !== 'scheduled') return;
  if (schedule.nextAt > now) return;

  if (schedule.stopAt <= now) {
    finish(schedule, 'completed', `the event has started — ${schedule.remaining.length} people were not invited`);
    await saveScheduledInvite(schedule);
    return;
  }

  const invite = await getInvite(schedule.inviteId);
  if (!invite) {
    finish(schedule, 'cancelled', 'the invitation history was deleted');
    await saveScheduledInvite(schedule);
    return;
  }

  const invited = schedule.force ? new Set<string>() : await getInvitedEmails(schedule.listId);
  const candidates = schedule.remaining.filter((email) => schedule.force || !invited.has(email));
  if (!candidates.length) {
    schedule.remaining = [];
    finish(schedule, 'completed');
    await saveScheduledInvite(schedule);
    return;
  }

  const accounts = await accountAllowances(schedule.connectionIds, new Date(now));
  const capped = accounts.map((a) => ({ ...a, allowance: Math.min(a.allowance, schedule.batchSize) }));
  const split = planInviteSplit(candidates, capped);

  if (!split.totalCapacity) {
    schedule.error = 'no chosen account has sending headroom right now — retrying';
    schedule.nextAt = now + SCHEDULE_RETRY_MS;
    await saveScheduledInvite(schedule);
    return;
  }

  const round = await sendInviteRound({
    listId: schedule.listId,
    event: schedule.event,
    allocation: split.allocated,
    accounts,
    batchSize: schedule.batchSize,
    now: new Date(now),
  });

  // Keep the invitation record (and its event IDs) complete for history and attendance.
  const startChunk = invite.batches.length;
  round.batches.forEach((batch, i) => {
    invite.batches.push({ ...batch, chunk: startChunk + i + 1 });
  });
  invite.senders = mergeSenders(invite.senders, round.senders);
  invite.recipientCount += round.sentEmails.length;
  if (round.firstError) invite.error = round.firstError;
  if (round.sentEmails.length === 0) invite.status = 'failed';
  else if (round.failedEmails.length || invite.error) invite.status = 'partial';
  else if (invite.status !== 'partial') invite.status = 'sent';
  await saveInvite(invite);

  const events: ScheduledInviteEvent[] = round.batches.map((batch) => ({
    connectionId: batch.connectionId ?? '',
    eventId: batch.eventId,
    htmlLink: batch.htmlLink,
    count: batch.count,
  }));

  schedule.rounds.push({
    at: now,
    completedAt: Date.now(),
    sent: round.sentEmails.length,
    failed: round.failedEmails.length,
    events,
    error: round.firstError,
  });

  // Emails not allocated this round plus the ones whose event failed stay for the next try.
  const remaining = Array.from(new Set([...split.unplaced, ...round.failedEmails]));
  schedule.remaining = remaining;
  schedule.error = round.firstError;

  if (!remaining.length) {
    finish(schedule, 'completed');
  } else if (round.sentEmails.length === 0) {
    schedule.nextAt = now + SCHEDULE_RETRY_MS;
  } else {
    const next = nextRoundAt(Date.now(), schedule.delayMs);
    if (next >= schedule.stopAt) {
      finish(schedule, 'completed', `stopped before the event start with ${remaining.length} not invited`);
    } else {
      schedule.nextAt = next;
    }
  }

  await saveScheduledInvite(schedule);
  inc('scheduled_invite_rounds_total', {}, 1);
  logger.info(
    { scheduleId: id, sent: round.sentEmails.length, failed: round.failedEmails.length, remaining: remaining.length },
    'scheduled invite round complete',
  );
}
