import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { listCampaigns } from '../domain/campaignStore';
import { queueLength } from '../domain/campaignStore';
import { getSenderGauge, getSenderProfile } from '../domain/senderStore';
import { finalizeIfDone, redistributeStranded, sendFromSender, startCampaign, endCampaign, markBatchRound } from '../domain/campaignDispatch';
import { campaignTickAction } from '../domain/campaignLifecycle';
import { saveCampaign } from '../domain/campaignStore';
import {
  allocateBatch,
  dueForNextBatch,
  jitterDelay,
  orderClaims,
  senderReadiness,
  type SenderClaim,
} from '../domain/campaignSchedule';

export interface MailboxTickResult {
  connectionId: string;
  sent: number;
  failed: number;
  campaigns: string[];
  /** Per-campaign successes, used to close a batched round only when something actually went out. */
  sentByCampaign?: Record<string, number>;
  reason?: string;
}

export interface TickResult {
  mailboxes: number;
  sent: number;
  failed: number;
  redistributed: number;
  campaigns: string[];
}

async function activeCampaigns(now = Date.now()) {
  return (await listCampaigns()).filter(
    (c) => c.status === 'active' && (!c.nextBatchAt || c.nextBatchAt <= now),
  );
}

/**
 * Serve one mailbox: fold its claims across every active campaign into a single
 * priority-ordered budget, then send one batch per campaign slice. This is where
 * multi-campaign arbitration happens — a mailbox is a shared, rate-limited resource.
 */
async function runMailbox(connectionId: string, maxPerSender: number, now: Date, ignoreDelay: boolean): Promise<MailboxTickResult> {
  const base: MailboxTickResult = { connectionId, sent: 0, failed: 0, campaigns: [], sentByCampaign: {} };
  const active = await activeCampaigns(now.getTime());

  const claims: SenderClaim[] = [];
  for (const camp of active) {
    const ps = camp.senders.find((s) => s.connectionId === connectionId);
    if (!ps || !ps.enabled) continue;
    const queued = await queueLength(camp.id, connectionId);
    if (queued > 0) claims.push({ campaignId: camp.id, campaignPriority: ps.priority ?? 5, createdAt: camp.createdAt, queued });
  }
  if (!claims.length) return { ...base, reason: 'nothing queued for this mailbox' };

  const profile = await getSenderProfile(connectionId);
  const gauge = await getSenderGauge(connectionId, now);

  const readiness = senderReadiness({
    enabled: profile.enabled,
    inWindow: gauge.inWindow,
    coolingUntil: gauge.state.cooldownUntil,
    now: now.getTime(),
    capToday: gauge.capToday,
    sentToday: gauge.sentToday,
    hourlyCap: profile.hourlyCap,
    sentThisHour: gauge.sentThisHour,
  });
  if (!readiness.ready) return { ...base, reason: readiness.reason };

  if (!ignoreDelay && !dueForNextBatch(gauge.state.lastSentAt, profile.minDelayMs, now.getTime())) {
    return { ...base, reason: 'inter-batch delay' };
  }

  const ordered = orderClaims(claims);
  // A batched campaign asks for up to its own per-round ceiling, which can be higher than the
  // scheduler's normal per-mailbox tick budget. Raise the pool only as far as a batch requires;
  // non-batched claims are still capped at `maxPerSender` below.
  const batchCeiling = ordered.reduce((max, claim) => {
    const camp = active.find((c) => c.id === claim.campaignId);
    return Math.max(max, camp?.eventBatchSize ?? 0);
  }, 0);
  const budget = allocateBatch(Math.min(readiness.allowance, Math.max(maxPerSender, batchCeiling)), ordered);
  const campaigns: string[] = [];
  const sentByCampaign: Record<string, number> = {};
  let sent = 0;
  let failed = 0;

  for (const claim of ordered) {
    const camp = active.find((c) => c.id === claim.campaignId);
    const ps = camp && camp.senders.find((s) => s.connectionId === connectionId);
    if (!camp || !ps) continue;

    const cap = camp.eventBatchSize && camp.eventBatchSize > 0 ? camp.eventBatchSize : maxPerSender;
    const take = Math.min(budget[claim.campaignId] ?? 0, cap);
    if (take <= 0) continue;

    const res = await sendFromSender(camp, ps, take, { ignoreDelay: true });
    sent += res.sent;
    failed += res.failed;
    if (res.sent) sentByCampaign[camp.id] = (sentByCampaign[camp.id] ?? 0) + res.sent;
    if (res.sent || res.failed) campaigns.push(camp.id);
  }

  return {
    connectionId,
    sent,
    failed,
    campaigns,
    sentByCampaign,
    reason: sent || failed ? undefined : 'no capacity',
  };
}

/**
 * Activate campaigns whose scheduled start has arrived, and end any past their deadline.
 *
 * Runs before the send pass so it only ever sees campaigns that should genuinely be sending. A
 * scheduled campaign whose audience turns out to be empty is paused with `lastError` rather than
 * being retried silently on every tick.
 */
async function applyLifecycle(now: Date): Promise<void> {
  const camps = await listCampaigns();

  for (const camp of camps) {
    // A batched campaign cannot usefully invite people after its event has begun.
    if (camp.eventBatchSize && (camp.status === 'active' || camp.status === 'scheduled')) {
      const start = Date.parse(camp.event.start);
      if (Number.isFinite(start) && now.getTime() >= start) {
        await endCampaign(camp.id, 'Stopped at the event start');
        logger.info({ campaignId: camp.id }, 'campaign ended at its event start');
        continue;
      }
    }

    const action = campaignTickAction(camp, now.getTime());

    if (action === 'activate') {
      try {
        await startCampaign(camp.id);
        logger.info({ campaignId: camp.id }, 'scheduled campaign activated');
      } catch (err) {
        const msg = (err as Error).message;
        camp.status = 'paused';
        camp.lastError = `Could not start on schedule: ${msg}`;
        await saveCampaign(camp);
        logger.warn({ campaignId: camp.id, err: msg }, 'scheduled campaign could not start; paused for review');
      }
      continue;
    }

    if (action === 'end') {
      await endCampaign(camp.id, 'Stopped at the send-by time');
      logger.info({ campaignId: camp.id }, 'campaign ended at its send-by time');
    }
  }
}

/** One full pass over every mailbox that has campaign work queued. */
export async function runCampaignTick(options: { maxPerSender?: number; now?: Date } = {}): Promise<TickResult> {
  const now = options.now ?? new Date();
  const maxPerSender = options.maxPerSender ?? 200;

  // Lifecycle first, so the send pass only sees campaigns that should actually be sending.
  await applyLifecycle(now);

  const active = await activeCampaigns(now.getTime());
  if (!active.length) return { mailboxes: 0, sent: 0, failed: 0, redistributed: 0, campaigns: [] };

  const mailboxes = new Set<string>();
  for (const camp of active) {
    for (const s of camp.senders) {
      if (!s.enabled) continue;
      if ((await queueLength(camp.id, s.connectionId)) > 0) mailboxes.add(s.connectionId);
    }
  }

  let sent = 0;
  let failed = 0;
  let worked = 0;
  const campaigns = new Set<string>();
  const sentByCampaign: Record<string, number> = {};

  for (const connectionId of mailboxes) {
    try {
      const res = await runMailbox(connectionId, maxPerSender, now, false);
      sent += res.sent;
      failed += res.failed;
      if (res.sentByCampaign) {
        for (const [id, count] of Object.entries(res.sentByCampaign)) {
          sentByCampaign[id] = (sentByCampaign[id] ?? 0) + count;
        }
      }
      if (res.sent || res.failed) {
        worked += 1;
        res.campaigns.forEach((id) => campaigns.add(id));
      } else if (res.reason && res.reason !== 'nothing queued for this mailbox') {
        logger.debug({ connectionId, reason: res.reason }, 'campaign tick skipped mailbox');
      }
    } catch (err) {
      logger.error({ connectionId, err: (err as Error).message }, 'campaign tick failed for mailbox');
    }
  }

  // Close a batched round only when something actually went out; a failed round retries next tick.
  for (const [campaignId, count] of Object.entries(sentByCampaign)) {
    if (count <= 0) continue;
    try {
      await markBatchRound(campaignId, now.getTime());
    } catch (err) {
      logger.error({ campaignId, err: (err as Error).message }, 'failed to close campaign batch round');
    }
  }

  let redistributed = 0;
  for (const camp of active) {
    try {
      redistributed += await redistributeStranded(camp);
    } catch (err) {
      logger.error({ campaignId: camp.id, err: (err as Error).message }, 'redistribution failed');
    }
  }

  for (const camp of active) {
    try {
      await finalizeIfDone(camp.id);
    } catch (err) {
      logger.error({ campaignId: camp.id, err: (err as Error).message }, 'campaign finalize failed');
    }
  }

  inc('campaign_ticks_total');
  if (sent || failed || redistributed) {
    logger.info({ sent, failed, redistributed, mailboxes: worked, campaigns: [...campaigns] }, 'campaign tick complete');
  }

  return { mailboxes: worked, sent, failed, redistributed, campaigns: [...campaigns] };
}

/** Operator-pressed "send now" for a single mailbox (caps still apply, pacing does not). */
export async function runSenderNow(connectionId: string, maxPerSender = 200): Promise<MailboxTickResult> {
  return runMailbox(connectionId, maxPerSender, new Date(), true);
}

/**
 * Self-rescheduling loop with jittered spacing so a fleet of mailboxes never fires in
 * lockstep. A tick is never started while the previous one is still running.
 */
export function startCampaignScheduler(): NodeJS.Timeout {
  const base = Math.max(1000, env.CAMPAIGN_TICK_INTERVAL_MS);
  const gap = (): number => base + jitterDelay(Math.floor(base * 0.1));
  let timer: NodeJS.Timeout | undefined;

  const run = (): void => {
    void runCampaignTick()
      .catch((err) => logger.error({ err: (err as Error).message }, 'campaign scheduler tick failed'))
      .then(
        () => { timer = setTimeout(run, gap()); },
        () => { timer = setTimeout(run, gap()); },
      );
  };

  timer = setTimeout(run, gap());
  return timer;
}
