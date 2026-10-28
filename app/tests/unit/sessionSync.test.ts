import { describe, it, expect } from 'vitest';
import {
  dueForPendingRetry,
  PENDING_RETRY_INTERVAL_MS,
  REPORT_RETRY_WINDOW_MS,
  syncOutcome,
} from '../../src/domain/sessionSync';

const END_ISO = '2026-10-20T18:00:00.000Z';
const END = Date.parse(END_ISO);

describe('syncOutcome', () => {
  it('marks a published report as synced', () => {
    expect(syncOutcome({ reportReady: true, endTime: END_ISO, now: END })).toBe('synced');
  });

  it('keeps a missing report pending right after the call', () => {
    expect(syncOutcome({ reportReady: false, endTime: END_ISO, now: END + 60_000 })).toBe('pending');
  });

  it('keeps retrying for the whole window', () => {
    expect(syncOutcome({ reportReady: false, endTime: END_ISO, now: END + REPORT_RETRY_WINDOW_MS })).toBe('pending');
  });

  it('stops retrying once the window has passed', () => {
    expect(syncOutcome({ reportReady: false, endTime: END_ISO, now: END + REPORT_RETRY_WINDOW_MS + 1 })).toBe('synced');
  });

  it('accepts a custom window', () => {
    expect(syncOutcome({ reportReady: false, endTime: END_ISO, now: END + 1_001, retryWindowMs: 1_000 })).toBe('synced');
  });

  it('gives up immediately when the end time cannot be read', () => {
    expect(syncOutcome({ reportReady: false, endTime: 'not a date', now: END })).toBe('synced');
  });
});

describe('dueForPendingRetry', () => {
  it('retries when there has never been an attempt', () => {
    expect(dueForPendingRetry({ now: 1_000 })).toBe(true);
  });

  it('waits an hour between automatic retries', () => {
    const now = 10_000_000;
    expect(dueForPendingRetry({ lastSyncedAt: now - 60_000, now })).toBe(false);
    expect(dueForPendingRetry({ lastSyncedAt: now - PENDING_RETRY_INTERVAL_MS, now })).toBe(true);
  });

  it('accepts a custom interval', () => {
    expect(dueForPendingRetry({ lastSyncedAt: 1_000, now: 2_500, intervalMs: 1_000 })).toBe(true);
    expect(dueForPendingRetry({ lastSyncedAt: 1_000, now: 1_500, intervalMs: 1_000 })).toBe(false);
  });
});
