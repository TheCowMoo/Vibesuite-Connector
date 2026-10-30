import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { createInviteEvent } from '../google/events';
import { getConnection } from './connectionStore';
import { getList } from './listStore';
import { chunk, eventStartEpoch } from './invite';
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
  clearCampaignVariantMap,
  clearRecipients,
  getCampaign,
  getCampaignVariantMap,
  markCampaignTestEvent,
  popQueue,
  pushQueue,
  queueLength,
  releaseRecipient,
  requeueFront,
  resetCampaignCounters,
  saveCampaign,
  saveRecipient,
  setCampaignVariantMap,
  setRecipients,
  tryClaimRecipient,
} from './campaignStore';
import { allocateEmails, type Campaign, type CampaignSender, type RecipientRecord } from './campaign';
import { assignVariants, campaignVariants, groupEmailsByVariant } from './campaignVariants';
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
  await clearCampaignVariantMap(id);

  // Freeze the A/B/C/D split with the audience. The queue still carries plain emails; this map is
  // what lets a mailbox group its claimed slice by variant without an extra read per recipient.
  const variants = campaignVariants(camp);
  const variantByEmail = assignVariants(emails, variants);
  await setCampaignVariantMap(id, variantByEmail);

  const allocated = allocateEmails(emails, camp.senders);
  const records: RecipientRecord[] = [];
  const perSender: Record<string, number> = {};

  for (const connectionId of Object.keys(allocated)) {
    const list_ = allocated[connectionId];
    perSender[connectionId] = list_.length;
    for (const email of list_) {
      records.push({
        email,
        connectionId,
        status: 'pending',
        variant: variantByEmail[email.trim().toLowerCase()] ?? variants[0].id,
      });
    }
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

  const allowance = Math.min(
    readiness.allowance,
    camp.eventBatchSize && camp.eventBatchSize > 0 ? Math.min(maxCount, camp.eventBatchSize) : maxCount,
    queued,
  );
  if (allowance <= 0) {
    return { connectionId: ps.connectionId, sent: 0, failed: 0, remaining: queued, skipped: true, reason: 'nothing queued' };
  }

  const joinUrl = await resolveJoinUrl(camp);
  const now = new Date();
  const todayISO = isoDate(now);
  const hourISO = isoHour(now);

  {
    const popped = await popQueue(campaignId, ps.connectionId, allowance);
    const variants = campaignVariants(camp);
    const fallbackVariant = variants[0].id;
    const activeVariants = new Set(variants.map((v) => v.id));
    const variantByEmail = await getCampaignVariantMap(campaignId, popped);

    // Claim first — a recipient is only ever invited once per campaign.
    const claimed: string[] = [];
    for (const email of popped) {
      const raw = variantByEmail[email.trim().toLowerCase()];
      const variant = (raw && activeVariants.has(raw as typeof fallbackVariant) ? raw : fallbackVariant) as typeof fallbackVariant;
      if (await tryClaimRecipient(campaignId, email)) claimed.push(email);
      else await saveRecipient(campaignId, { email, connectionId: ps.connectionId, status: 'sent', sentAt: Date.now(), variant });
    }

    // Each variant gets its own event(s): Google Calendar has one summary/description per event.
    // `eventBatchSize` is the total for this account this round, split across the variant groups.
    const grouped = groupEmailsByVariant(claimed, variantByEmail, fallbackVariant, variants);
    let sent = 0;
    let failed = 0;
    const failedEmails: string[] = [];

    for (const variant of variants) {
      const group = grouped.get(variant.id) ?? [];
      if (!group.length) continue;

      const parts = camp.eventBatchSize && camp.eventBatchSize > 0
        ? [group]
        : chunk(group, env.INVITE_BATCH_SIZE);

      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        if (!part.length) continue;
        const summary = parts.length > 1 ? `${variant.summary} (${i + 1}/${parts.length})` : variant.summary;
        try {
          const res = await createInviteEvent(conn, {
            summary,
            description: variant.description ?? camp.event.description,
            location: joinUrl || camp.event.location,
            start: camp.event.start,
            end: camp.event.end,
            timeZone: camp.event.timeZone,
            emails: part,
          });

          sent += part.length;
          for (const email of part) {
            await saveRecipient(campaignId, {
              email,
              connectionId: ps.connectionId,
              status: 'sent',
              sentAt: Date.now(),
              eventId: res.id,
              variant: variant.id,
            });
          }
          await markInvited(camp.listId, part, {
            summary: variant.summary,
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
            await saveRecipient(campaignId, {
              email,
              connectionId: ps.connectionId,
              status: 'failed',
              error: msg,
              variant: variant.id,
            });
            await releaseRecipient(campaignId, email);
          }
          await bumpSenderDay(ps.connectionId, todayISO, 'failed', part.length);
          await bumpCampaignSender(campaignId, ps.connectionId, 'failed', part.length);
          inc('campaign_invites_failed_total');
          logger.error({ campaignId, connectionId: ps.connectionId, variant: variant.id, err: msg }, 'campaign invite batch failed');
        }
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

  const activeVariants = campaignVariants(camp);
  const activeIds = new Set(activeVariants.map((v) => v.id));
  const fallbackVariant = activeVariants[0].id;
  let moved = 0;

  for (const from of stranded) {
    const queued = await queueLength(camp.id, from);
    if (queued <= 0) continue;

    const emails = await popQueue(camp.id, from, queued);
    if (!emails.length) continue;
    const variantByEmail = await getCampaignVariantMap(camp.id, emails);

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
        const raw = variantByEmail[email.trim().toLowerCase()];
        await saveRecipient(camp.id, {
          email,
          connectionId: target,
          status: 'pending',
          variant: (raw && activeIds.has(raw as typeof fallbackVariant) ? raw : fallbackVariant) as typeof fallbackVariant,
        });
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

  if (camp.eventBatchSize) {
    if (camp.nextBatchAt && camp.nextBatchAt > Date.now()) {
      throw new Error(`this campaign is between batches — the next round opens at ${new Date(camp.nextBatchAt).toISOString()}`);
    }
    const eventStart = eventStartEpoch(camp.event.start, camp.event.timeZone);
    if (eventStart !== null && Date.now() >= eventStart) {
      throw new Error('the event has already started — an invitation would arrive too late');
    }
  }

  const perSender: SenderBatchResult[] = [];
  let sent = 0;
  let failed = 0;
  const limit = camp.eventBatchSize ? Math.max(maxPerSender, camp.eventBatchSize) : maxPerSender;

  for (const ps of camp.senders) {
    if (!ps.enabled) continue;
    const res = await sendFromSender(camp, ps, limit, { ignoreDelay: true });
    perSender.push(res);
    sent += res.sent;
    failed += res.failed;
  }

  if (sent > 0) await markBatchRound(campaignId);

  const completed = await finalizeIfDone(campaignId);
  return { sent, failed, perSender, completed };
}

/**
 * Close a batched campaign's round: the next send pass will skip it until the delay expires.
 *
 * Called by the scheduler after a tick that actually sent something, and by the manual "Send a batch"
 * action, so both paths respect the same interval.
 */
export async function markBatchRound(campaignId: string, now = Date.now()): Promise<void> {
  const camp = await getCampaign(campaignId);
  if (!camp || !camp.eventBatchSize || !camp.batchDelayMinutes) return;
  camp.lastBatchAt = now;
  camp.nextBatchAt = now + camp.batchDelayMinutes * 60_000;
  await saveCampaign(camp);
}

export interface TestCopyResult {
  eventId: string;
  htmlLink?: string;
  variantId: string;
  sentTo: string[];
}

/**
 * Send a real calendar invite with one variant's copy to test addresses.
 *
 * This deliberately does not touch recipients, queues, caps, stats or `list:{id}:invited`: it is a
 * preview of the actual invitation, not a send. The event ID is remembered so the RSVP pipeline
 * ignores responses to it.
 */
export async function sendCampaignTestCopy(
  camp: Campaign,
  input: { emails: string[]; variantId?: string; connectionId?: string },
): Promise<TestCopyResult> {
  const variants = campaignVariants(camp);
  const variant = input.variantId
    ? variants.find((v) => v.id === input.variantId)
    : variants[0];
  if (!variant) throw new Error(`copy variant ${input.variantId} not found`);

  const sender = camp.senders.find(
    (s) => s.enabled && (!input.connectionId || s.connectionId === input.connectionId),
  );
  if (!sender) throw new Error('choose an enabled sending account from this campaign');

  const conn = await getConnection(sender.connectionId);
  if (!conn) throw new Error('sending account not found');
  if (conn.status !== 'active') throw new Error('sending account is not connected to Google');

  const emails = Array.from(
    new Set(
      (input.emails || [])
        .map((email) => String(email).trim().toLowerCase())
        .filter(Boolean),
    ),
  );
  if (!emails.length) throw new Error('add at least one test email address');
  if (emails.length > 5) throw new Error('a test copy can go to at most 5 addresses');
  const invalid = emails.find((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (invalid) throw new Error(`not a valid email address: ${invalid}`);

  const eventStart = eventStartEpoch(camp.event.start, camp.event.timeZone);
  if (eventStart !== null && eventStart <= Date.now()) {
    throw new Error('the event has already started — a test copy would arrive too late');
  }

  const joinUrl = await resolveJoinUrl(camp);
  const res = await createInviteEvent(conn, {
    summary: `[TEST] ${variant.summary}`,
    description: variant.description ?? camp.event.description,
    location: joinUrl || camp.event.location,
    start: camp.event.start,
    end: camp.event.end,
    timeZone: camp.event.timeZone,
    emails,
  });

  await markCampaignTestEvent(conn.id, res.id);
  return { eventId: res.id, htmlLink: res.htmlLink, variantId: variant.id, sentTo: emails };
}
