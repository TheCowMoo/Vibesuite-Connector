import { ADVISOR_ACTION_KINDS, clampAdvisorAction, type Recommendation } from './advisorActions';
import type { AdvisorSnapshot } from './advisorSnapshot';

const AI_SHAPE =
  '{"summary":"one paragraph overall read","recommendations":[{"title":"...","severity":"info|warning|critical",' +
  '"rationale":"why, citing the snapshot numbers","impact":"expected effect",' +
  '"action":{"kind":"set_sender_daily_cap","target":"Mailbox B","value":400}}]}';

export function buildAdvisorPrompt(snapshot: AdvisorSnapshot): string {
  return [
    'You are the delivery advisor for an outreach platform that sends Google Calendar invitations',
    'from several Google Workspace mailboxes. Analyse the operational snapshot below and recommend',
    'concrete, conservative changes that protect sender reputation and let campaigns finish.',
    '',
    'Rules:',
    '- Safety first: never recommend a daily cap above 2000, an hourly cap above 500, or a delay',
    '  below 1000ms. Prefer spreading load across mailboxes over pushing one mailbox harder.',
    '- Cite the snapshot numbers in every rationale. Do not invent metrics that are not present.',
    '- Refer to mailboxes and campaigns only by their snapshot labels.',
    '- Only use these action kinds: ' + ADVISOR_ACTION_KINDS.join(', ') + '.',
    '- Every action target must be an exact label from the snapshot.',
    '- If nothing needs changing, return an empty recommendations array.',
    '',
    'Return JSON shaped exactly like:',
    AI_SHAPE,
    '',
    'Snapshot (contains no personal data):',
    JSON.stringify(snapshot, null, 2),
  ].join('\n');
}

export function buildAdvisorQuestionPrompt(snapshot: AdvisorSnapshot, question: string): string {
  return [
    "Answer the operator's question using only the snapshot below. Be concise and specific, quote the",
    'relevant numbers, say plainly when the snapshot does not contain the answer, and never invent data.',
    '',
    'Snapshot (contains no personal data):',
    JSON.stringify(snapshot, null, 2),
    '',
    'Operator question: ' + question,
  ].join('\n');
}

/** Deterministic rules, so the Advisor is still useful without an AI key. */
export function localRecommendations(snapshot: AdvisorSnapshot): Recommendation[] {
  const out: Recommendation[] = [];
  let n = 0;

  const push = (rec: Omit<Recommendation, 'id' | 'state'>): void => {
    n += 1;
    out.push({ ...rec, id: `local-${n}`, state: 'open' });
  };

  for (const m of snapshot.mailboxes) {
    if (m.cooling) {
      push({
        title: `${m.label} is in cooldown`,
        severity: 'critical',
        rationale: `${m.label} has an error streak of ${m.errorStreak} and is cooling down, so its queued invites are being redistributed to the other mailboxes.`,
        impact: 'Verify the mailbox credentials and Google quota before the cooldown expires.',
        action: { kind: 'pause_sender', target: m.label },
      });
      continue;
    }

    if (!m.enabled) {
      push({
        title: `${m.label} is paused`,
        severity: 'warning',
        rationale: `${m.label} is paused, so every campaign listing it is running on fewer mailboxes.`,
        impact: 'Resuming restores capacity immediately.',
        action: { kind: 'resume_sender', target: m.label },
      });
      continue;
    }

    if (m.hourlyCap && m.sentThisHour >= Math.floor(m.hourlyCap * 0.9)) {
      push({
        title: `${m.label} is close to its hourly ceiling`,
        severity: 'warning',
        rationale: `${m.label} sent ${m.sentThisHour} of its ${m.hourlyCap}/hour allowance, so the scheduler will stall it until the hour rolls over.`,
        impact: 'A higher hourly cap keeps the batch cadence even.',
        action: {
          kind: 'set_sender_hourly_cap',
          target: m.label,
          value: Math.min(500, m.hourlyCap + Math.max(10, Math.round(m.hourlyCap * 0.5))),
        },
      });
      continue;
    }

    if (m.capToday > 0 && m.sentToday >= Math.floor(m.capToday * 0.95) && m.failedToday === 0) {
      push({
        title: `${m.label} finished its daily allowance cleanly`,
        severity: 'info',
        rationale: `${m.label} sent ${m.sentToday} of ${m.capToday} with no failures today — a good reliability signal.`,
        impact: 'A larger daily cap uses proven capacity without extra risk.',
        action: { kind: 'set_sender_daily_cap', target: m.label, value: Math.min(2000, Math.round(m.dailyCap * 1.25)) },
      });
      continue;
    }

    if (m.failedToday > 0 && m.failedToday >= Math.max(3, Math.round(m.sentToday * 0.1))) {
      push({
        title: `${m.label} is failing more than 10% of its sends`,
        severity: 'critical',
        rationale: `${m.label} recorded ${m.failedToday} failures against ${m.sentToday} successes today.`,
        impact: "Adds a deliberate delay so Google's rate limiter can recover.",
        action: { kind: 'set_sender_min_delay_ms', target: m.label, value: Math.max(1000, (m.minDelayMs ?? 0) * 2) },
      });
    }
  }

  for (const c of snapshot.campaigns) {
    if (c.status === 'active' && c.queued > 0 && c.mailboxes <= 1) {
      push({
        title: `${c.label} is running on a single mailbox`,
        severity: 'warning',
        rationale: `${c.label} still has ${c.queued} invites queued with only ${c.mailboxes} mailbox assigned.`,
        impact: 'Adding a second mailbox roughly halves the remaining delivery time.',
      });
    }
  }

  return out;
}

/** Clamp every model-proposed action; anything that fails to clamp becomes advisory-only. */
export function sanitizeRecommendations(raw: unknown, startIndex = 0): Recommendation[] {
  const list = Array.isArray((raw as { recommendations?: unknown })?.recommendations)
    ? ((raw as { recommendations: Array<Record<string, unknown>> }).recommendations)
    : [];

  const out: Recommendation[] = [];
  let n = startIndex;

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    n += 1;

    const severity = String(item.severity ?? 'info').toLowerCase();
    const clamped = clampAdvisorAction(item.action as never);

    out.push({
      id: `ai-${n}`,
      title: String(item.title ?? 'Recommendation').slice(0, 200),
      severity: severity === 'critical' || severity === 'warning' ? (severity as Recommendation['severity']) : 'info',
      rationale: String(item.rationale ?? '').slice(0, 1200),
      impact: item.impact ? String(item.impact).slice(0, 600) : undefined,
      action: clamped.ok ? clamped.action : undefined,
      actionLabel: clamped.ok ? clamped.description : 'Advisory only',
      state: 'open',
    });
  }

  return out;
}
