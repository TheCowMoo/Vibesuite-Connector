import { createCalendarClient } from './auth';
import type { StoredConnection } from '../domain/connection';
import { resolveEventTime } from '../domain/invite';

export interface InviteEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  timeZone?: string;
  emails: string[];
  guestsCanSeeOtherGuests?: boolean;
}

export interface InviteEventResult {
  id: string;
  htmlLink?: string;
}

/**
 * Create a Google Calendar event with `sendUpdates: 'all'` so Google emails a
 * real invitation to every attendee. Guest list is hidden by default so a mass
 * invite never leaks the full recipient list.
 */
export async function createInviteEvent(conn: StoredConnection, input: InviteEventInput): Promise<InviteEventResult> {
  const calendar = createCalendarClient(conn);
  const start = resolveEventTime(input.start, input.timeZone);
  const end = resolveEventTime(input.end, input.timeZone);
  const res = await calendar.events.insert({
    calendarId: conn.googleCalendarId,
    sendUpdates: 'all',
    requestBody: {
      summary: input.summary,
      description: input.description,
      location: input.location,
      start,
      end,
      attendees: input.emails.map((email) => ({ email })),
      guestsCanInviteOthers: false,
      guestsCanModify: false,
      guestsCanSeeOtherGuests: input.guestsCanSeeOtherGuests ?? false,
    },
  });
  return { id: res.data.id ?? '', htmlLink: res.data.htmlLink ?? undefined };
}
