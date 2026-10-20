import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { createInviteEvent } from '../google/events';
import { getConnection } from './connectionStore';
import { getList } from './listStore';
import { chunk } from './invite';
import { buildAudience, describeEmptyAudience } from './audience';
import { getInvitedEmails, markInvited } from './inviteStore';
import { getSession } from './sessionStore';
import {
  bumpSenderDay,
  bumpSenderHour,
  getSenderGauge,
  getSenderProfile,
  getSenderState,
  isoHour,
  saveSenderState,
} from './senderStore';
import { isoDate } from './senderLoad';
import {
  bumpCampaignSender,
  clearCampaignQueues,
  clearRecipients,
  getCampaign,
  popQueue,
  pushQueue,
  queueLength,
  releaseRecipient,
  requeueFront,
  resetCampaignCounters,
  saveCampaign,
  saveRecipient,
  setRecipients,
  tryClaimRecipient,
} from './campaignStore';
import { allocateEmails, type Campaign, type CampaignSender, type RecipientRecord } from './campaign';
import { startBlockedByDeadline } from './campaignLifecycle';
import { dueForNextBatch, senderReadiness } from './campaignSchedule';
import { sessionJoinUrl } from './joinLink';

function describeError(err: unknown): string {
  const e = err as { response?: { status?: number; data?: { error?: { message?: string } | string } }; message?: string };
  const status = e?.response?.status;
  const d = e?.response?.data?.error;
  const detail = typeof d === 'string' ? d : d?.message;
  const base = detail || e?.message || 'unknown error';
  return status ? `${status} ${base}` : base;
}

async function resolveJoinUrl(camp: Campaign): Promise<string | undefined> {
  if (!camp.sessionId) return undefined;
  const session = await getSession(camp.sessionId);
  return session ? sessionJoinUrl(session) : undefined;
}

/** Freeze the audience, drop anyone already invited for that list, partition across senders. */
export async function startCampaign(
  id: string,
): Promise<{
  recipients: number;
  perSender: Record<string, number>;
  alreadyInvited: number;
  invalid: number;
  reInviting: number;
}> {
  const camp = await getCampaign(id);
  if (!camp) throw new Error('campaign not found');

  // Freezing an audience for a campaign that is already out of time would queue work the next tick
  // immediately throws away; refusing up front tells the operator what to fix instead.
  const blocked = startBlockedByDeadline(camp, Date.now());
  if (blocked) throw new Error(blocked);

  const list = await getList(camp.listId);
  if (!list || !list.result) throw new Error('list has no segmentation result — run Segment first');

  // The same helper the invite composer previews with, so what the operator was shown before
  // pressing Begin sending is exactly what gets frozen here.
  // `includeAlreadyInvited` lets an operator deliberately re-invite a list. The repeat count is
  // taken against the unfiltered set, so the caller can report how many are re-invitations.
  const allInvited = await getInvitedEmails(camp.listId);
  const audience = buildAudience(
    list.result,
    camp.segments,
    camp.includeAlreadyInvited ? new Set<string>() : allInvited,
  );
  const emails = audience.emails;
  if (!emails.length) throw new Error(describeEmptyAudience(audience));
  const reInviting = camp.includeAlreadyInvited ? emails.filter((e) => allInvited.has(e)).length : 0;

  const connectionIds = camp.senders.map((s) => s.connectionId);
  await clearCampaignQueues(id, connectionIds);
  await resetCampaignCounters(id, connectionIds);
  await clearRecipients(id);

  const allocated = allocateEmails(emails, camp.senders);
  const records: RecipientRecord[] = [];
  const perSender: Record<string, number> = {};

  for (const connectionId of Object.keys(allocated)) {
    const list_ = allocated[connectionId];
    perSender[connectionId] = list_.length;
    for (const email of list_) records.push({ email, connectionId, status: 'pending' });
    await pushQueue(id, connectionId, list_);
  }

  await setRecipients(id, records);
  camp.status = 'active';
  camp.startedAt = Date.now();
  camp.completedAt = undefined;
  // The start time has been consumed — whether the scheduler fired it or an operator pressed
  // "Begin now" early — so it must not linger and describe a start that already happened.
  camp.scheduledStartAt = undefined;
  await saveCampaign(camp);

  return {
    recipients: records.length,
    perSender,
    alreadyInvited: audience.alreadyInvited.length,
    invalid: audience.invalid.length,
    reInviting,
  };
}

export interface SenderBatchResult {
  connectionId: string;
  sent: number;
  failed: number;
  remaining: number;
  skipped: boolean;
  reason?: string;
}

export interface BatchResult {
  sent: number;
  failed: number;
  perSender: SenderBatchResult[];
  completed: boolean;
}

export interface SendOptions {
  /** Operators pressing "send now" skip the inter-batch pacing delay. */
  ignoreDelay?: boolean;
}

/**
 * Send at most `maxCount` invites from one mailbox for one campaign, honouring that
 * mailbox's cap, ramp, hourly limit, send window and cooldown.
 */
export async function sendFromSender(
  camp: Campaign,
  ps: CampaignSender,
  maxCount: number,
  opts: SendOptions = {},
): Promise<SenderBatchResult> {
  const campaignId = camp.id;
  const queued = await queueLength(campaignId, ps.connectionId);
  const conn = await getConnection(ps.connectionId);
  if (!conn) {
    return { connectionId: ps.connectionId, sent: 0, failed: 0, remaining: queued, skipped: true, reason: 'connection missing' };
  }

  const profile = await getSenderProfile(ps.connectionId);
  const gauge = await getSenderGauge(ps.connectionId);

  const readiness = senderReadiness({
    enabled: profile.enabled,
    inWindow: gauge.inWindow,
    coolingUntil: gauge.state.cooldownUntil,
    now: Date.now(),
    capToday: gauge.capToday,
    sentToday: gauge.sentToday,
    hourlyCap: profile.hourlyCap,
    sentThisHour: gauge.sentThisHour,
  });
  if (!readiness.ready) {
    return { connectionId: ps.connectionId, sent: 0, failed: 0, remaining: queued, skipped: true, reason: readiness.reason };
  }
  if (!opts.ignoreDelay && !dueForNextBatch(gauge.state.lastSentAt, profile.minDelayMs, Date.now())) {
    return { connectionId: ps.connectionId, sent: 0, failed: 0, remaining: queued, skipped: true, reason: 'inter-batch delay' };
  }

  const allowance = Math.min(readiness.allowance, maxCount, queued);
  if (allowance <= 0) {
    return { connectionId: ps.connectionId, sent: 0, failed: 0, remaining: queued, skipped: true, reason: 'nothing queued' };
  }

  const joinUrl = await resolveJoinUrl(camp);
  const now = new Date();
  const todayISO = isoDate(now);
  const hourISO = isoHour(now);

  {
    const popped = await popQueue(campaignId, ps.connectionId, allowance);

    // Claim first — a recipient is only ever invited once per campaign.
    const claimed: string[] = [];
    for (const email of popped) {
      if (await tryClaimRecipient(campaignId, email)) claimed.push(email);
      else await saveRecipient(campaignId, { email, connectionId: ps.connectionId, status: 'sent', sentAt: Date.now() });
    }

    const parts = chunk(claimed, env.INVITE_BATCH_SIZE);
    let sent = 0;
    let failed = 0;
    const failedEmails: string[] = [];

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const summary = parts.length > 1 ? `${camp.event.summary} (${i + 1}/${parts.length})` : camp.event.summary;
      try {
        const res = await createInviteEvent(conn, {
          summary,
          description: camp.event.description,
          location: joinUrl || camp.event.location,
          start: camp.event.start,
          end: camp.event.end,
          timeZone: camp.event.timeZone,
          emails: part,
        });

        sent += part.length;
        for (const email of part) {
          await saveRecipient(campaignId, { email, connectionId: ps.connectionId, status: 'sent', sentAt: Date.now(), eventId: res.id });
        }
        await markInvited(camp.listId, part, {
          summary: camp.event.summary,
          start: camp.event.start,
          source: 'campaign',
        });
        await bumpSenderDay(ps.connectionId, todayISO, 'sent', part.length);
        await bumpSenderHour(ps.connectionId, hourISO, part.length);
        await bumpCampaignSender(campaignId, ps.connectionId, 'sent', part.length);
        inc('campaign_invites_sent_total');
      } catch (err) {
        const msg = describeError(err);
        failed += part.length;
        failedEmails.push(...part);
        for (const email of part) {
          await saveRecipient(campaignId, { email, connectionId: ps.connectionId, status: 'failed', error: msg });
          await releaseRecipient(campaignId, email);
        }
        await bumpSenderDay(ps.connectionId, todayISO, 'failed', part.length);
        await bumpCampaignSender(campaignId, ps.connectionId, 'failed', part.length);
        inc('campaign_invites_failed_total');
        logger.error({ campaignId, connectionId: ps.connectionId, err: msg }, 'campaign invite batch failed');
      }
    }

    // Sender health: cooldown on repeated failures, clear on success.
    const state = await getSenderState(ps.connectionId);
    if (failed > 0) {
      state.errorStreak = (state.errorStreak ?? 0) + 1;
      state.lastError = 'invite batch failed';
      if (state.errorStreak >= env.CAMPAIGN_COOLDOWN_ON_ERRORS) {
        state.cooldownUntil = Date.now() + env.CAMPAIGN_COOLDOWN_HOURS * 3600000;
        logger.warn({ connectionId: ps.connectionId, hours: env.CAMPAIGN_COOLDOWN_HOURS }, 'sender cooled down after repeated errors');
      }
      await requeueFront(campaignId, ps.connectionId, failedEmails);
    } else if (sent > 0) {
      state.errorStreak = 0;
      state.lastError = undefined;
      state.lastSentAt = Date.now();
    }
    await saveSenderState(ps.connectionId, state);

    return {
      connectionId: ps.connectionId,
      sent,
      failed,
      remaining: await queueLength(campaignId, ps.connectionId),
      skipped: false,
    };
  }
}

/** Flip a campaign to `completed` once every mailbox queue is empty. */
export async function finalizeIfDone(campaignId: string): Promise<boolean> {
  const camp = await getCampaign(campaignId);
  if (!camp) return false;

  const outstanding = (await Promise.all(camp.senders.map((s) => queueLength(campaignId, s.connectionId)))).reduce((a, b) => a + b, 0);
  if (outstanding > 0) return false;

  if (camp.status === 'active') {
    camp.status = 'completed';
    camp.completedAt = Date.now();
    await saveCampaign(camp);
  }
  return true;
}

/**
 * Move queued work off mailboxes that cannot make progress (paused or cooling) onto
 * mailboxes that can, so one bad mailbox never strands a campaign. Cooldowns are
 * temporary, but the work still moves — the cooled mailbox refills on its own.
 */
/**
 * Stop a campaign for good.
 *
 * Queues are intentionally left intact: the detail view still reports what never went out, and
 * `counts.pending` stays truthful. Nothing already sent is recalled — people who were invited keep
 * their calendar invitations.
 */
export async function endCampaign(id: string, reason?: string): Promise<Campaign | null> {
  const camp = await getCampaign(id);
  if (!camp) return null;
  if (camp.status === 'ended' || camp.status === 'completed') return camp;

  camp.status = 'ended';
  camp.completedAt = Date.now();
  camp.scheduledStartAt = undefined;
  if (reason) camp.lastError = reason;
  await saveCampaign(camp);
  return camp;
}

export async function redistributeStranded(camp: Campaign): Promise<number> {
  const gauges = await Promise.all(camp.senders.map((s) => getSenderGauge(s.connectionId)));
  const healthy: CampaignSender[] = [];
  const stranded: string[] = [];

  camp.senders.forEach((s, i) => {
    if (s.enabled && !gauges[i].cooling) healthy.push(s);
    else stranded.push(s.connectionId);
  });
  if (!healthy.length || !stranded.length) return 0;

  let moved = 0;

  for (const from of stranded) {
    const queued = await queueLength(camp.id, from);
    if (queued <= 0) continue;

    const emails = await popQueue(camp.id, from, queued);
    if (!emails.length) continue;

    const targets = healthy.filter((h) => h.connectionId !== from);
    if (!targets.length) {
      await requeueFront(camp.id, from, emails);
      continue;
    }

    const allocated = allocateEmails(
      emails,
      targets.map((t) => ({ connectionId: t.connectionId, enabled: true, priority: t.priority })),
    );

    for (const target of Object.keys(allocated)) {
      const slice = allocated[target];
      if (!slice.length) continue;
      await pushQueue(camp.id, target, slice);
      for (const email of slice) {
        await saveRecipient(camp.id, { email, connectionId: target, status: 'pending' });
      }
      moved += slice.length;
    }

    logger.info({ campaignId: camp.id, from, moved: emails.length }, 'redistributed stranded invites');
  }

  if (moved > 0) inc('campaign_invites_redistributed_total', {}, moved);
  return moved;
}

/**
 * Send a batch from every enabled mailbox of a campaign — the manual "send batch"
 * action. The scheduler calls `sendFromSender` directly so it can arbitrate between
 * campaigns that share a mailbox.
 */
export async function sendCampaignBatch(campaignId: string, maxPerSender = 200): Promise<BatchResult> {
  const camp = await getCampaign(campaignId);
  if (!camp) throw new Error('campaign not found');
  if (camp.status !== 'active') throw new Error('campaign is not active');

  // A manual batch must respect the stop time too, otherwise it can slip invitations out between the
  // deadline passing and the next scheduler tick ending the campaign.
  const blocked = startBlockedByDeadline(camp, Date.now());
  if (blocked) throw new Error(blocked);

  const perSender: SenderBatchResult[] = [];
  let sent = 0;
  let failed = 0;

  for (const ps of camp.senders) {
    if (!ps.enabled) continue;
    const res = await sendFromSender(camp, ps, maxPerSender, { ignoreDelay: true });
    perSender.push(res);
    sent += res.sent;
    failed += res.failed;
  }

  const completed = await finalizeIfDone(campaignId);
  return { sent, failed, perSender, completed };
}
