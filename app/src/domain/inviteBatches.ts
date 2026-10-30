export interface BatchAccount {
  connectionId: string;
  /** How many this account can take in a round (preview: its current allowance). */
  allowance: number;
}

export interface BatchRound {
  round: number;
  /** Planned start of the round (the first is `now`). */
  at: number;
  perAccount: Record<string, number>;
  total: number;
}

export interface BatchPlan {
  rounds: BatchRound[];
  /** Recipients that do not fit in the plan (no capacity, or the event-start guard cut it). */
  unplaced: number;
  /** Planned start of the last round, or null when nothing can be sent. */
  finishAt: number | null;
  /** True when `stopAt` prevented at least one round. */
  cutShort: boolean;
}

/**
 * Estimate the rounds of a batched invite.
 *
 * Each account may contribute up to `batchSize` per round, and never more than its allowance. The
 * preview treats the allowance as per-round capacity; the real sender re-reads live headroom at each
 * round, so a capped account can produce smaller rounds than this estimate.
 *
 * `stopAt` is the event start: a round that would begin at or after it is not planned, and whatever
 * is left is reported as `unplaced` with `cutShort`, so the composer can warn before sending.
 */
export function planBatchRounds(input: {
  total: number;
  accounts: BatchAccount[];
  batchSize: number;
  delayMs: number;
  now: number;
  stopAt?: number;
}): BatchPlan {
  const batchSize = Math.max(1, Math.floor(input.batchSize) || 1);
  const delayMs = Math.max(0, Math.floor(input.delayMs) || 0);
  const usable = input.accounts.filter((a) => a.allowance > 0);

  const rounds: BatchRound[] = [];
  let remaining = Math.max(0, Math.floor(input.total) || 0);
  let cutShort = false;

  while (remaining > 0) {
    const at = input.now + rounds.length * delayMs;
    if (input.stopAt !== undefined && at >= input.stopAt) {
      cutShort = true;
      break;
    }

    const perAccount: Record<string, number> = {};
    let taken = 0;

    for (const account of usable) {
      const take = Math.min(batchSize, account.allowance, remaining - taken);
      if (take <= 0) continue;
      perAccount[account.connectionId] = take;
      taken += take;
      if (taken >= remaining) break;
    }

    if (taken === 0) break;

    rounds.push({ round: rounds.length + 1, at, perAccount, total: taken });
    remaining -= taken;
  }

  return {
    rounds,
    unplaced: remaining,
    finishAt: rounds.length ? rounds[rounds.length - 1].at : null,
    cutShort,
  };
}

/** When the next round is due, given the previous round's completion time. */
export function nextRoundAt(completedAt: number, delayMs: number): number {
  return completedAt + Math.max(0, Math.floor(delayMs) || 0);
}
