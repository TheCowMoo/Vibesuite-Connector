import { describe, it, expect } from 'vitest';
import { nextRoundAt, planBatchRounds } from '../../src/domain/inviteBatches';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-29T09:00:00.000Z');
const accounts = (n: number, allowance: number) =>
  Array.from({ length: n }, (_, i) => ({ connectionId: `c${i + 1}`, allowance }));

describe('planBatchRounds', () => {
  it('plans one round of up to 300 per account', () => {
    const plan = planBatchRounds({ total: 900, accounts: accounts(3, 300), batchSize: 300, delayMs: DAY, now: NOW });
    expect(plan.rounds).toHaveLength(1);
    expect(plan.rounds[0].perAccount).toEqual({ c1: 300, c2: 300, c3: 300 });
    expect(plan.rounds[0].total).toBe(900);
    expect(plan.unplaced).toBe(0);
    expect(plan.cutShort).toBe(false);
    expect(plan.finishAt).toBe(NOW);
  });

  it('adds a round per delay when the audience is larger', () => {
    const plan = planBatchRounds({ total: 1800, accounts: accounts(3, 300), batchSize: 300, delayMs: DAY, now: NOW });
    expect(plan.rounds.map((r) => r.at)).toEqual([NOW, NOW + DAY]);
    expect(plan.rounds.map((r) => r.total)).toEqual([900, 900]);
    expect(plan.finishAt).toBe(NOW + DAY);
  });

  it('respects a lower allowance per account', () => {
    const plan = planBatchRounds({ total: 900, accounts: accounts(1, 100), batchSize: 300, delayMs: DAY, now: NOW });
    expect(plan.rounds).toHaveLength(9);
    expect(plan.rounds.every((r) => r.total === 100)).toBe(true);
    expect(plan.rounds[8].at).toBe(NOW + 8 * DAY);
  });

  it('stops before the event start and reports the remainder', () => {
    const plan = planBatchRounds({
      total: 1800,
      accounts: accounts(3, 300),
      batchSize: 300,
      delayMs: DAY,
      now: NOW,
      stopAt: NOW + 12 * 60 * 60 * 1000,
    });
    expect(plan.rounds).toHaveLength(1);
    expect(plan.unplaced).toBe(900);
    expect(plan.cutShort).toBe(true);
  });

  it('plans nothing when no account can send', () => {
    const plan = planBatchRounds({ total: 500, accounts: accounts(2, 0), batchSize: 300, delayMs: DAY, now: NOW });
    expect(plan.rounds).toEqual([]);
    expect(plan.unplaced).toBe(500);
    expect(plan.finishAt).toBeNull();
  });

  it('allows back-to-back rounds when the delay is zero', () => {
    const plan = planBatchRounds({ total: 900, accounts: accounts(1, 300), batchSize: 300, delayMs: 0, now: NOW });
    expect(plan.rounds.map((r) => r.at)).toEqual([NOW, NOW, NOW]);
  });

  it('treats a nonsensical batch size as one', () => {
    const plan = planBatchRounds({ total: 2, accounts: accounts(1, 10), batchSize: 0, delayMs: DAY, now: NOW });
    expect(plan.rounds.map((r) => r.total)).toEqual([1, 1]);
  });
});

describe('nextRoundAt', () => {
  it('adds the delay to the completion time', () => {
    expect(nextRoundAt(NOW, DAY)).toBe(NOW + DAY);
    expect(nextRoundAt(NOW, 0)).toBe(NOW);
    expect(nextRoundAt(NOW, -5)).toBe(NOW);
  });
});
