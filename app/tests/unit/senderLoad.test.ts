import { describe, it, expect } from 'vitest';
import {
  DEFAULT_WINDOW,
  dailyCapFor,
  daysBetween,
  isWithinWindow,
  localParts,
  rampCapForDay,
  rampDayIndex,
  type SenderProfile,
} from '../../src/domain/senderLoad';

const base: SenderProfile = {
  connectionId: 'c1',
  enabled: true,
  mode: 'flat',
  dailyCap: 800,
  window: { ...DEFAULT_WINDOW, timeZone: 'UTC' },
};

const ramp = { startDailyCap: 50, incrementPerDay: 50, maxDailyCap: 300, startDate: '2026-10-01' };

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(0);
    expect(daysBetween('2026-10-01', '2026-10-03')).toBe(2);
  });
  it('never goes negative', () => {
    expect(daysBetween('2026-10-03', '2026-10-01')).toBe(0);
  });
});

describe('rampCapForDay', () => {
  it('ramps up from the start cap', () => {
    expect(rampCapForDay(ramp, 1)).toBe(50);
    expect(rampCapForDay(ramp, 2)).toBe(100);
    expect(rampCapForDay(ramp, 3)).toBe(150);
  });
  it('clamps at maxDailyCap', () => {
    expect(rampCapForDay(ramp, 10)).toBe(300);
  });
});

describe('dailyCapFor', () => {
  it('flat mode returns the daily cap', () => {
    expect(dailyCapFor(base, '2026-10-08')).toBe(800);
  });

  it('ramp mode can never exceed dailyCap', () => {
    const p: SenderProfile = {
      ...base,
      mode: 'ramp',
      dailyCap: 120,
      ramp: { startDailyCap: 50, incrementPerDay: 50, maxDailyCap: 500, startDate: '2026-10-06' },
    };
    expect(rampDayIndex(p, '2026-10-08')).toBe(3);
    expect(dailyCapFor(p, '2026-10-08')).toBe(120); // ramp would be 150 → clamped
  });
});

describe('localParts', () => {
  it('resolves hour + weekday per timezone', () => {
    expect(localParts('UTC', new Date('2026-10-08T10:00:00Z'))).toEqual({ hour: 10, weekday: 4 });
    expect(localParts('Asia/Manila', new Date('2026-10-08T10:00:00Z'))).toEqual({ hour: 18, weekday: 4 });
  });
});

describe('isWithinWindow', () => {
  const win = { ...DEFAULT_WINDOW, timeZone: 'UTC' }; // 09:00–17:00, Mon–Fri

  it('inside on a weekday morning', () => {
    expect(isWithinWindow(win, new Date('2026-10-08T10:00:00Z'))).toBe(true); // Thursday
  });

  it('outside before/after hours', () => {
    expect(isWithinWindow(win, new Date('2026-10-08T03:00:00Z'))).toBe(false);
    expect(isWithinWindow(win, new Date('2026-10-08T20:00:00Z'))).toBe(false);
  });

  it('outside on a weekend', () => {
    expect(isWithinWindow(win, new Date('2026-10-10T10:00:00Z'))).toBe(false); // Saturday
  });

  it('honours the timezone', () => {
    const manila = { ...DEFAULT_WINDOW, timeZone: 'Asia/Manila' }; // UTC+8
    expect(isWithinWindow(manila, new Date('2026-10-08T01:00:00Z'))).toBe(true); // 09:00 local
    expect(isWithinWindow(win, new Date('2026-10-08T01:00:00Z'))).toBe(false);
  });

  it('treats an equal start/end as always open', () => {
    expect(isWithinWindow({ ...win, startHour: 9, endHour: 9, days: [] }, new Date('2026-10-08T03:00:00Z'))).toBe(true);
  });
});
