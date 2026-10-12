import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { createInviteEvent } from '../google/events';
import { getConnection } from './connectionStore';
import { getList } from './listStore';
import { extractRecipients, chunk } from './invite';
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
import { allocateEmails, type Campaign, type RecipientRecord } from './campaign';

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
  if (!session) return undefined;
  if (session.joinUrl) return session.joinUrl;
  if (session.provider === 'zoom' && session.externalId) return `https://zoom.us/j/${encodeURIComponent(session.externalId)}`;
  return undefined;
}

/** Freeze the audience, drop anyone already invited for that list, partition across senders. */
export async function startCampaign(id: string): Promise<{ recipients: number; perSender: Record<string, number> }> {
  const camp = await getCampaign(id);
  if (!camp) throw new Error('campaign not found');

  const list = await getList(camp.listId);
  if (!list || !list.result) throw new Error('list has no segmentation result — run Segment first');

  const plan = extractRecipients(list.result, camp.segments);
  const alreadyInvited = await getInvitedEmails(camp.listId);
  const emails = plan.emails.filter((e) => !alreadyInvited.has(e));
  if (!emails.length) throw new Error('no recipients to send to (empty, invalid, or already invited)');

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
  await saveCampaign(camp);

  return { recipients: records.length, perSender };
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

/**
 * Send at most `maxPerSender` invites per mailbox right now, honouring each
 * mailbox's cap, ramp, window and cooldown. Returns what actually went out.
 */
export async function sendCampaignBatch(campaignId: string, maxPerSender = 200): Promise<BatchResult> {
  const camp = await getCampaign(campaignId);
  if (!camp) throw new Error('campaign not found');
  if (camp.status !== 'active') throw new Error('campaign is not active');

  const joinUrl = await resolveJoinUrl(camp);
  const now = new Date();
  const todayISO = isoDate(now);
  const hourISO = isoHour(now);

  const perSender: SenderBatchResult[] = [];
  let totalSent = 0;
  let totalFailed = 0;

  for (const ps of camp.senders) {
    if (!ps.enabled) continue;
    const queued = await queueLength(campaignId, ps.connectionId);
    const conn = await getConnection(ps.connectionId);
    if (!conn) {
      perSender.push({ connectionId: ps.connectionId, sent: 0, failed: 0, remaining: queued, skipped: true, reason: 'connection missing' });
      continue;
    }

    const profile = await getSenderProfile(ps.connectionId);
    const gauge = await getSenderGauge(ps.connectionId, now);

    let reason = '';
    if (!profile.enabled) reason = 'paused';
    else if (gauge.cooling) reason = 'cooling down';
    else if (!gauge.inWindow) reason = 'outside send window';

    const allowance = Math.min(gauge.headroom, maxPerSender, queued);
    if (reason || allowance <= 0) {
      perSender.push({
        connectionId: ps.connectionId,
        sent: 0,
        failed: 0,
        remaining: queued,
        skipped: true,
        reason: reason || 'at daily cap',
      });
      continue;
    }

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
        await markInvited(camp.listId, part);
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

    perSender.push({
      connectionId: ps.connectionId,
      sent,
      failed,
      remaining: await queueLength(campaignId, ps.connectionId),
      skipped: false,
    });
    totalSent += sent;
    totalFailed += failed;
  }

  const outstanding = (
    await Promise.all(camp.senders.map((s) => queueLength(campaignId, s.connectionId)))
  ).reduce((a, b) => a + b, 0);

  if (outstanding === 0) {
    camp.status = 'completed';
    camp.completedAt = Date.now();
    await saveCampaign(camp);
  }

  return { sent: totalSent, failed: totalFailed, perSender, completed: outstanding === 0 };
}
