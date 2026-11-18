import { normalizeVerificationEmail, type StoredEmailVerification } from './emailVerificationStore';

export interface VerificationSummary {
  total: number;
  checked: number;
  deliverable: number;
  undeliverable: number;
  doNotSend: number;
  catchAll: number;
  unknown: number;
  unchecked: number;
}

export interface VerificationPolicyResult {
  /** Emails allowed to proceed. Undeliverable and do-not-send are removed. */
  allowed: string[];
  excluded: { doNotSend: string[]; undeliverable: string[] };
  summary: VerificationSummary;
  warnings: string[];
}

export function emptyVerificationSummary(total = 0): VerificationSummary {
  return {
    total,
    checked: 0,
    deliverable: 0,
    undeliverable: 0,
    doNotSend: 0,
    catchAll: 0,
    unknown: 0,
    unchecked: total,
  };
}

export function summarizeVerification(
  emails: string[],
  results: Map<string, StoredEmailVerification>,
): VerificationSummary {
  const unique = Array.from(new Set(emails.map(normalizeVerificationEmail).filter(Boolean)));
  const summary = emptyVerificationSummary(unique.length);
  for (const email of unique) {
    const result = results.get(email);
    if (!result) continue;
    summary.checked += 1;
    if (result.result === 'deliverable') summary.deliverable += 1;
    else if (result.result === 'undeliverable') summary.undeliverable += 1;
    else if (result.result === 'do_not_send') summary.doNotSend += 1;
    else if (result.result === 'catch_all') summary.catchAll += 1;
    else summary.unknown += 1;
  }
  summary.unchecked = Math.max(0, summary.total - summary.checked);
  return summary;
}

/**
 * Warning-only policy.
 *
 * GHL's verdict removes only the two decisive bad outcomes: `do_not_send` (suppression) and
 * `undeliverable` (mailbox does not exist). Catch-all, unknown and unchecked addresses still go
 * out — the operator sees a warning instead of losing legitimate recipients to a guess.
 */
export function applyVerificationPolicy(
  emails: string[],
  results: Map<string, StoredEmailVerification>,
): VerificationPolicyResult {
  const unique = Array.from(new Set(emails.map(normalizeVerificationEmail).filter(Boolean)));
  const summary = summarizeVerification(unique, results);
  const allowed: string[] = [];
  const excluded = { doNotSend: [] as string[], undeliverable: [] as string[] };

  for (const email of unique) {
    const result = results.get(email);
    if (result?.result === 'do_not_send') {
      excluded.doNotSend.push(email);
      continue;
    }
    if (result?.result === 'undeliverable') {
      excluded.undeliverable.push(email);
      continue;
    }
    allowed.push(email);
  }

  const warnings: string[] = [];
  const skipped = excluded.doNotSend.length + excluded.undeliverable.length;
  if (skipped > 0) {
    const parts: string[] = [];
    if (excluded.undeliverable.length) parts.push(`${excluded.undeliverable.length} undeliverable`);
    if (excluded.doNotSend.length) parts.push(`${excluded.doNotSend.length} do-not-send`);
    warnings.push(`${parts.join(' and ')} — those addresses will be skipped.`);
  }
  if (summary.catchAll > 0 || summary.unknown > 0) {
    const parts: string[] = [];
    if (summary.catchAll) parts.push(`${summary.catchAll} catch-all`);
    if (summary.unknown) parts.push(`${summary.unknown} unknown`);
    warnings.push(`${parts.join(' and ')} — GHL could not confirm those addresses, so they will still be invited.`);
  }
  if (summary.unchecked > 0) {
    warnings.push(
      `${summary.unchecked} address${summary.unchecked === 1 ? '' : 'es'} ${
        summary.unchecked === 1 ? 'has' : 'have'
      } not been verified and will still be invited.`,
    );
  }

  return { allowed, excluded, summary, warnings };
}

/** Display-only estimate; GHL bills the location wallet at its own rate. */
export function estimateVerificationCostUsd(count: number, costPer1000 = 2.5): number {
  const checks = Math.max(0, Math.floor(count));
  return Math.round(((checks * costPer1000) / 1000) * 10000) / 10000;
}
