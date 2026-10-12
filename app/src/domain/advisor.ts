import { env } from '../config/env';
import { logger } from '../lib/logger';
import { generateJson, generateText } from '../lib/ai';
import { getAiSettings } from './aiSettings';
import { listConnections } from './connectionStore';
import { getCampaign, listCampaigns, saveCampaign } from './campaignStore';
import { getSenderGauge, getSenderHistory, getSenderProfile, saveSenderProfile } from './senderStore';
import { collectCampaignStats } from './campaignStatsCollect';
import {
  SNAPSHOT_APPENDIX,
  campaignLabel,
  mailboxLabel,
  type AdvisorSnapshot,
  type CampaignSnapshot,
  type MailboxSnapshot,
} from './advisorSnapshot';
import {
  buildAdvisorPrompt,
  buildAdvisorQuestionPrompt,
  localRecommendations,
  sanitizeRecommendations,
} from './advisorPrompt';
import { clampAdvisorAction, type AdvisorAction, type Recommendation } from './advisorActions';
import { appendApplyLog, getAnalysis, getApplyLog, saveAnalysis } from './advisorStore';
import type { AdvisorAnalysis, AdvisorTargets, ApplyLogEntry } from './advisorTypes';

const SYSTEM =
  'You are a deliverability and capacity advisor for a cold-outreach operation that sends Google ' +
  'Calendar invitations through multiple Google Workspace mailboxes. You are conservative, you never ' +
  'recommend risky volume, and you always justify a change with numbers from the snapshot.';

const ASK_SYSTEM =
  'You are the delivery advisor for an outreach platform. Answer strictly from the supplied aggregate ' +
  'snapshot, quote the numbers you rely on, and say "the snapshot does not contain that" when it is true.';

export async function collectAdvisorSnapshot(): Promise<{ snapshot: AdvisorSnapshot; targets: AdvisorTargets }> {
  const targets: AdvisorTargets = { mailboxes: [], campaigns: [] };

  const connections = await listConnections();
  const mailboxes: MailboxSnapshot[] = [];
  let mi = 0;
  for (const conn of connections) {
    const label = mailboxLabel(mi);
    mi += 1;
    targets.mailboxes.push({ label, connectionId: conn.id });

    const gauge = await getSenderGauge(conn.id);
    mailboxes.push({
      label,
      enabled: gauge.profile.enabled,
      mode: gauge.profile.mode,
      dailyCap: gauge.profile.dailyCap,
      hourlyCap: gauge.profile.hourlyCap,
      minDelayMs: gauge.profile.minDelayMs,
      window: gauge.profile.window,
      ramp: gauge.profile.ramp,
      capToday: gauge.capToday,
      sentToday: gauge.sentToday,
      failedToday: gauge.failedToday,
      sentThisHour: gauge.sentThisHour,
      errorStreak: gauge.state.errorStreak ?? 0,
      cooling: gauge.cooling,
      cooldownUntil: gauge.state.cooldownUntil,
      history: await getSenderHistory(conn.id, 14),
    });
  }

  const campaigns: CampaignSnapshot[] = [];
  let ci = 0;
  for (const camp of await listCampaigns()) {
    const label = campaignLabel(ci);
    ci += 1;
    targets.campaigns.push({ label, id: camp.id });

    const { funnel, hasAttendance } = await collectCampaignStats(camp);
    campaigns.push({
      label,
      status: camp.status,
      spread: camp.distribution.mode,
      mailboxes: camp.senders.filter((s) => s.enabled).length,
      invited: funnel.invited,
      queued: funnel.queued,
      sent: funnel.sent,
      failed: funnel.failed,
      accepted: funnel.accepted,
      declined: funnel.declined,
      tentative: funnel.tentative,
      noResponse: funnel.noResponse,
      attended: funnel.attended,
      noShow: funnel.noShow,
      rsvpRate: funnel.rsvpRate,
      acceptanceRate: funnel.acceptanceRate,
      attendanceRate: funnel.attendanceRate,
      hasAttendance,
    });
  }

  return {
    snapshot: {
      generatedAt: Date.now(),
      settings: {
        tickIntervalMs: env.CAMPAIGN_TICK_INTERVAL_MS,
        defaultDailyCap: env.CAMPAIGN_DEFAULT_DAILY_CAP,
        defaultHourlyCap: env.CAMPAIGN_DEFAULT_HOURLY_CAP,
        defaultMinDelayMs: env.CAMPAIGN_DEFAULT_MIN_DELAY_MS,
        cooldownOnErrors: env.CAMPAIGN_COOLDOWN_ON_ERRORS,
        cooldownHours: env.CAMPAIGN_COOLDOWN_HOURS,
      },
      mailboxes,
      campaigns,
    },
    targets,
  };
}

export interface AdvisorState {
  analysis: AdvisorAnalysis | null;
  log: ApplyLogEntry[];
  appendix: typeof SNAPSHOT_APPENDIX;
  aiConfigured: boolean;
}

export async function getAdvisorState(): Promise<AdvisorState> {
  const [analysis, log, settings] = await Promise.all([getAnalysis(), getApplyLog(50), getAiSettings()]);
  return { analysis, log, appendix: SNAPSHOT_APPENDIX, aiConfigured: !!(settings && settings.apiKey) };
}

/**
 * Snapshot -> AI (when configured) + built-in rules -> stored analysis.
 * The model never sees identities, only Mailbox A/B/C and Campaign 1/2/3 labels.
 */
export async function analyzeAdvisor(): Promise<AdvisorAnalysis> {
  const { snapshot, targets } = await collectAdvisorSnapshot();
  const local = localRecommendations(snapshot);

  const settings = await getAiSettings();
  let summary = 'Built-in rules only — add an AI provider in Settings for a written read of the data.';
  let note: string | undefined = 'No AI provider configured, so these are the built-in rules.';
  let provider: string | null = null;
  let model: string | null = null;
  let aiRecs: Recommendation[] = [];

  if (settings && settings.apiKey) {
    try {
      const raw = await generateJson<{ summary?: string }>(settings, SYSTEM, buildAdvisorPrompt(snapshot));
      aiRecs = sanitizeRecommendations(raw, 0);
      const written = String(raw?.summary ?? '').trim();
      if (written) summary = written.slice(0, 2000);
      provider = settings.provider;
      model = settings.model;
      note = undefined;
    } catch (err) {
      const message = (err as Error).message;
      note = `The AI provider call failed (${message}), so these are the built-in rules.`;
      logger.error({ err: message }, 'advisor analysis failed');
    }
  }

  const analysis: AdvisorAnalysis = {
    createdAt: Date.now(),
    provider,
    model,
    summary,
    note,
    snapshot,
    targets,
    recommendations: [...aiRecs, ...local],
  };

  await saveAnalysis(analysis);
  return analysis;
}

function resolveTarget(targets: AdvisorTargets, label: string): { connectionId?: string; campaignId?: string } | null {
  const mailbox = targets.mailboxes.find((m) => m.label === label);
  if (mailbox) return { connectionId: mailbox.connectionId };
  const camp = targets.campaigns.find((c) => c.label === label);
  if (camp) return { campaignId: camp.id };
  return null;
}

async function applySenderAction(action: AdvisorAction, connectionId: string): Promise<void> {
  const profile = await getSenderProfile(connectionId);

  switch (action.kind) {
    case 'set_sender_daily_cap':
      profile.dailyCap = action.value as number;
      break;
    case 'set_sender_hourly_cap':
      profile.hourlyCap = action.value as number;
      break;
    case 'set_sender_min_delay_ms':
      profile.minDelayMs = action.value as number;
      break;
    case 'set_sender_window':
      profile.window = {
        ...profile.window,
        startHour: action.startHour as number,
        endHour: action.endHour as number,
        days: action.days as number[],
      };
      break;
    case 'pause_sender':
      profile.enabled = false;
      break;
    case 'resume_sender':
      profile.enabled = true;
      break;
    default:
      throw new Error(`"${action.kind}" cannot be applied to a mailbox`);
  }

  await saveSenderProfile(profile);
}

async function applyCampaignAction(action: AdvisorAction, campaignId: string): Promise<void> {
  const camp = await getCampaign(campaignId);
  if (!camp) throw new Error('campaign no longer exists');

  if (action.kind === 'set_campaign_status') {
    camp.status = action.status === 'active' ? 'active' : 'paused';
  } else if (action.kind === 'set_campaign_priority') {
    const value = action.value as number;
    camp.senders = camp.senders.map((s) => ({ ...s, priority: value }));
  } else {
    throw new Error(`"${action.kind}" cannot be applied to a campaign`);
  }

  await saveCampaign(camp);
}

/** One-click Apply. Never automatic — the operator presses the button. */
export async function applyRecommendation(
  id: string,
  actor?: string,
): Promise<{ ok: boolean; error?: string; recommendation?: Recommendation; description?: string }> {
  const analysis = await getAnalysis();
  if (!analysis) return { ok: false, error: 'run an analysis first' };

  const rec = analysis.recommendations.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'recommendation not found' };
  if (rec.state !== 'open') return { ok: false, error: `this recommendation was already ${rec.state}` };
  if (!rec.action) return { ok: false, error: 'this recommendation is advisory only' };

  const clamped = clampAdvisorAction(rec.action);
  if (!clamped.ok) return { ok: false, error: clamped.error };

  const label = clamped.action.target as string;
  const target = resolveTarget(analysis.targets, label);
  if (!target) return { ok: false, error: `unknown target "${label}"` };

  try {
    if (target.connectionId) await applySenderAction(clamped.action, target.connectionId);
    else if (target.campaignId) await applyCampaignAction(clamped.action, target.campaignId);
  } catch (err) {
    const message = (err as Error).message;
    await appendApplyLog({
      at: Date.now(),
      recommendationId: rec.id,
      title: rec.title,
      description: clamped.description,
      actor,
      ok: false,
      error: message,
    });
    return { ok: false, error: message };
  }

  rec.state = 'applied';
  rec.appliedAt = Date.now();
  await saveAnalysis(analysis);
  await appendApplyLog({
    at: Date.now(),
    recommendationId: rec.id,
    title: rec.title,
    description: clamped.description,
    actor,
    ok: true,
  });

  return { ok: true, recommendation: rec, description: clamped.description };
}

export async function dismissRecommendation(
  id: string,
): Promise<{ ok: boolean; error?: string; recommendation?: Recommendation }> {
  const analysis = await getAnalysis();
  if (!analysis) return { ok: false, error: 'run an analysis first' };

  const rec = analysis.recommendations.find((r) => r.id === id);
  if (!rec) return { ok: false, error: 'recommendation not found' };

  rec.state = 'dismissed';
  await saveAnalysis(analysis);
  return { ok: true, recommendation: rec };
}

/** Ephemeral follow-up thread: grounded on the stored snapshot, never persisted. */
export async function askAdvisor(question: string): Promise<{ answer: string }> {
  const clean = String(question ?? '').trim().slice(0, 1000);
  if (!clean) throw new Error('ask a question');

  const settings = await getAiSettings();
  if (!settings || !settings.apiKey) throw new Error('add an AI provider in Settings to ask follow-up questions');

  const stored = await getAnalysis();
  const snapshot = stored ? stored.snapshot : (await collectAdvisorSnapshot()).snapshot;

  const answer = await generateText(settings, ASK_SYSTEM, buildAdvisorQuestionPrompt(snapshot, clean));
  return { answer: String(answer || '').trim() };
}
