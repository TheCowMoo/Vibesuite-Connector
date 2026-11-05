import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GCalEvent } from '../../src/google/types';

const { fakeRedis, hashes } = vi.hoisted(() => {
  const hashes = new Map<string, Map<string, string>>();
  const fakeRedis = {
    pipeline() {
      const ops: Array<() => [Error | null, unknown]> = [];
      const pipe = {
        hgetall(key: string) {
          ops.push(() => [null, Object.fromEntries(hashes.get(key) || [])]);
          return pipe;
        },
        hset(key: string, field: string, value: string) {
          ops.push(() => {
            let hash = hashes.get(key);
            if (!hash) {
              hash = new Map();
              hashes.set(key, hash);
            }
            hash.set(field, value);
            return [null, 1];
          });
          return pipe;
        },
        hsetnx(key: string, field: string, value: string) {
          ops.push(() => {
            let hash = hashes.get(key);
            if (!hash) {
              hash = new Map();
              hashes.set(key, hash);
            }
            if (hash.has(field)) return [null, 0];
            hash.set(field, value);
            return [null, 1];
          });
          return pipe;
        },
        async exec() {
          return ops.map((op) => op());
        },
      };
      return pipe;
    },
  };
  return { fakeRedis, hashes };
});

vi.mock('../../src/queue/connection', () => ({ redis: fakeRedis }));
vi.mock('../../src/config/constants', () => ({
  REDIS_KEYS: {
    rsvpHistory: (connectionId: string, eventId: string) => `conn:${connectionId}:rsvp:history:${eventId}`,
  },
}));

import { ensureRsvpBaseline, getRsvpHistory, recordRsvpHistory } from '../../src/domain/rsvpHistoryStore';

function event(id: string, attendees: Array<[string, string]>): GCalEvent {
  return {
    id,
    status: 'confirmed',
    attendees: attendees.map(([email, responseStatus]) => ({ email, responseStatus })),
  } as unknown as GCalEvent;
}

beforeEach(() => hashes.clear());

describe('recordRsvpHistory', () => {
  it('stores the first observation as an initial baseline and deduplicates repeats', async () => {
    await recordRsvpHistory('c1', [event('e1', [['Ada@Example.com', 'accepted']])], 100);
    let index = await getRsvpHistory('c1', ['e1']);
    expect(index.get('e1')?.get('ada@example.com')).toEqual([
      { status: 'accepted', at: 100, initial: true },
    ]);

    await recordRsvpHistory('c1', [event('e1', [['ada@example.com', 'accepted']])], 200);
    index = await getRsvpHistory('c1', ['e1']);
    expect(index.get('e1')?.get('ada@example.com')).toHaveLength(1);
  });

  it('appends a real status change', async () => {
    await recordRsvpHistory('c1', [event('e1', [['ada@example.com', 'accepted']])], 100);
    await recordRsvpHistory('c1', [event('e1', [['ada@example.com', 'declined']])], 200);
    const index = await getRsvpHistory('c1', ['e1']);
    expect(index.get('e1')?.get('ada@example.com')).toEqual([
      { status: 'accepted', at: 100, initial: true },
      { status: 'declined', at: 200 },
    ]);
  });

  it('ignores cancelled events and attendees without an email', async () => {
    await recordRsvpHistory('c1', [
      { ...event('e1', [['ada@example.com', 'accepted']]), status: 'cancelled' } as GCalEvent,
      event('e2', [['', 'accepted']]),
    ], 100);
    expect(hashes.size).toBe(0);
  });
});

describe('ensureRsvpBaseline', () => {
  it('fills a missing history without overwriting an existing one', async () => {
    await recordRsvpHistory('c1', [event('e1', [['ada@example.com', 'accepted']])], 100);
    await ensureRsvpBaseline('c1', [
      { eventId: 'e1', email: 'ada@example.com', status: 'declined' },
      { eventId: 'e2', email: 'grace@example.com', status: 'tentative' },
    ], 300);

    const index = await getRsvpHistory('c1', ['e1', 'e2']);
    expect(index.get('e1')?.get('ada@example.com')).toEqual([
      { status: 'accepted', at: 100, initial: true },
    ]);
    expect(index.get('e2')?.get('grace@example.com')).toEqual([
      { status: 'tentative', at: 300, initial: true },
    ]);
  });
});
