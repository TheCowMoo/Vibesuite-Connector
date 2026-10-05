import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { logger } from '../lib/logger';
import { lookupContactByEmail } from './contacts';
import type { StoredConnection } from '../domain/connection';

export interface EventMapping {
  appointmentId?: string;
  contactId?: string;
}

export const mapping = {
  async setEventMapping(connectionId: string, eventId: string, m: EventMapping): Promise<void> {
    await redis.set(REDIS_KEYS.mapEvent(connectionId, eventId), JSON.stringify(m));
  },

  async getEventMapping(connectionId: string, eventId: string): Promise<EventMapping | null> {
    const raw = await redis.get(REDIS_KEYS.mapEvent(connectionId, eventId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as EventMapping;
    } catch {
      return null;
    }
  },

  async resolveContact(conn: StoredConnection, email: string): Promise<{ id: string } | null> {
    const key = REDIS_KEYS.mapContact(conn.id, email);
    const cached = await redis.get(key);
    if (cached) return { id: cached };

    try {
      const contact = await lookupContactByEmail(conn, email);
      if (contact?.id) {
        await redis.set(key, contact.id, 'EX', 3600);
        return { id: contact.id };
      }
    } catch (err) {
      logger.warn({ email, connectionId: conn.id, err: (err as Error).message }, 'GHL contact lookup failed');
    }
    return null;
  },

  async resolveAppointment(connectionId: string, eventId: string): Promise<{ id: string } | null> {
    const m = await this.getEventMapping(connectionId, eventId);
    if (m?.appointmentId) return { id: m.appointmentId };
    return null;
  },
};

