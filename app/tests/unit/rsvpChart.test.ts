import { describe, expect, it } from 'vitest';
import chart from '../../public/rsvpChart.js';

const { segments } = chart;

describe('RSVP donut segments', () => {
  it('turns response counts into percentages and start offsets', () => {
    const result = segments({ accepted: 5, tentative: 2, declined: 1, noResponse: 2 });

    expect(result.total).toBe(10);
    expect(result.items.map((item: { count: number; percent: number }) => item.count)).toEqual([5, 2, 1, 2]);
    expect(result.items.map((item: { percent: number }) => item.percent)).toEqual([50, 20, 10, 20]);
    expect(result.items.map((item: { startPercent: number }) => item.startPercent)).toEqual([0, 50, 70, 80]);
  });

  it('handles a single 100% segment', () => {
    const result = segments({ accepted: 0, tentative: 0, declined: 3, noResponse: 0 });

    expect(result.total).toBe(3);
    expect(result.items[2].percent).toBe(100);
    expect(result.items[2].startPercent).toBe(0);
    expect(result.items.filter((item: { count: number }) => item.count > 0)).toHaveLength(1);
  });

  it('returns zero percentages for an empty response mix', () => {
    const result = segments({ accepted: 0, tentative: 0, declined: 0, noResponse: 0 });

    expect(result.total).toBe(0);
    expect(result.items.every((item: { percent: number }) => item.percent === 0)).toBe(true);
    expect(result.items.every((item: { startPercent: number }) => item.startPercent === 0)).toBe(true);
  });

  it('ignores negative and non-numeric counts', () => {
    const result = segments({ accepted: -2, tentative: '3', declined: NaN, noResponse: undefined } as unknown as {
      accepted: number;
      tentative: number;
      declined: number;
      noResponse: number;
    });

    expect(result.total).toBe(3);
    expect(result.items[0].count).toBe(0);
    expect(result.items[1].count).toBe(3);
    expect(result.items[1].percent).toBe(100);
    expect(result.items[2].count).toBe(0);
    expect(result.items[3].count).toBe(0);
  });
});
