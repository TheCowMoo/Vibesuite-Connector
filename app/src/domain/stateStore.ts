import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { GCalEvent } from '../google/types';

export type AttendeeStateMap = Record<string, string>; // email -> responseStatus

export const stateStore = {
  async getSyncToken(connectionId: string): Promise<string | null> {
    return redis.get(REDIS_KEYS.syncToken(connectionId));
  },

  async saveSyncToken(connectionId: string, token: string): Promise<void> {
    await redis.set(REDIS_KEYS.syncToken(connectionId), token);
  },

  async getStates(connectionId: string): Promise<Map<string, AttendeeStateMap>> {
    const hash = await redis.hgetall(REDIS_KEYS.stateHash(connectionId));
    const map = new Map<string, AttendeeStateMap>();
    for (const [eventId, json] of Object.entries(hash)) {
      try {
        map.set(eventId, JSON.parse(json) as AttendeeStateMap);
      } catch {
        // ignore corrupt entries
      }
    }
    return map;
  },

  async saveStates(connectionId: string, events: GCalEvent[]): Promise<void> {
    const key = REDIS_KEYS.stateHash(connectionId);
    const multi = redis.multi();
    for (const event of events) {
      const state: AttendeeStateMap = {};
      for (const a of event.attendees ?? []) {
        if (a.email) state[a.email] = a.responseStatus ?? 'needsAction';
      }
      multi.hset(key, event.id, JSON.stringify(state));
    }
    await multi.exec();
  },

  async removeEvents(connectionId: string, eventIds: string[]): Promise<void> {
    if (eventIds.length === 0) return;
    await redis.hdel(REDIS_KEYS.stateHash(connectionId), ...eventIds);
  },

  async clear(connectionId: string): Promise<void> {
    await redis.del(REDIS_KEYS.syncToken(connectionId), REDIS_KEYS.stateHash(connectionId));
  },
};

