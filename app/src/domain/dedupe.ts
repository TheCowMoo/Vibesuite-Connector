import { createHash } from 'node:crypto';
import type { GCalEvent } from '../google/types';
import type { AttendeeStateMap } from './stateStore';

export interface AttendeeChange {
  eventId: string;
  email: string;
  previousStatus?: string;
  newStatus: string;
  causedByCancellation: boolean;
  event: GCalEvent;
}

export function computeChanges(events: GCalEvent[], prevStates: Map<string, AttendeeStateMap>): AttendeeChange[] {
  const changes: AttendeeChange[] = [];

  for (const event of events) {
    const prev = prevStates.get(event.id) ?? {};

    if (event.status === 'cancelled') {
      // A cancelled/deleted event is treated as a decline for every known attendee.
      for (const [email, prevStatus] of Object.entries(prev)) {
        if (prevStatus !== 'declined') {
          changes.push({
            eventId: event.id,
            email,
            previousStatus: prevStatus,
            newStatus: 'declined',
            causedByCancellation: true,
            event,
          });
        }
      }
      continue;
    }

    for (const a of event.attendees ?? []) {
      if (!a.email) continue;
      const newStatus = a.responseStatus ?? 'needsAction';
      const prevStatus = prev[a.email];
      if (prevStatus !== newStatus) {
        changes.push({
          eventId: event.id,
          email: a.email,
          previousStatus: prevStatus,
          newStatus,
          causedByCancellation: false,
          event,
        });
      }
    }
  }

  return changes;
}

export function buildChangeFingerprint(calendarId: string, change: AttendeeChange): string {
  const parts = [
    calendarId,
    change.eventId,
    change.email,
    change.previousStatus ?? '',
    change.newStatus,
    change.event.updated ?? '',
  ];
  return createHash('sha1').update(parts.join('\u0000')).digest('hex');
}
