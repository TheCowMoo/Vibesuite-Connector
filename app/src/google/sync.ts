import { createCalendarClient } from './auth';
import type { StoredConnection } from '../domain/connection';
import type { GCalEvent } from './types';

interface RawEvent {
  id?: string | null;
  status?: string | null;
  summary?: string | null;
  description?: string | null;
  start?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null; timeZone?: string | null } | null;
  updated?: string | null;
  attendees?: Array<{ email?: string | null; responseStatus?: string | null; displayName?: string | null }> | null;
}

function mapEvent(raw: RawEvent): GCalEvent {
  return {
    id: raw.id ?? '',
    status: raw.status ?? undefined,
    summary: raw.summary ?? undefined,
    description: raw.description ?? undefined,
    start: raw.start
      ? { dateTime: raw.start.dateTime ?? undefined, date: raw.start.date ?? undefined, timeZone: raw.start.timeZone ?? undefined }
      : undefined,
    end: raw.end
      ? { dateTime: raw.end.dateTime ?? undefined, date: raw.end.date ?? undefined, timeZone: raw.end.timeZone ?? undefined }
      : undefined,
    updated: raw.updated ?? undefined,
    attendees: (raw.attendees ?? [])
      .filter((a) => a?.email)
      .map((a) => ({ email: a.email as string, responseStatus: a.responseStatus ?? undefined, displayName: a.displayName ?? undefined })),
  };
}

interface PageResult {
  items: RawEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

async function paginate(fetchPage: (pageToken?: string) => Promise<PageResult>): Promise<{ items: GCalEvent[]; nextSyncToken: string }> {
  const items: GCalEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken = '';

  do {
    const page = await fetchPage(pageToken);
    items.push(...(page.items ?? []).map(mapEvent));
    pageToken = page.nextPageToken || undefined;
    nextSyncToken = page.nextSyncToken || nextSyncToken;
  } while (pageToken);

  return { items, nextSyncToken };
}

export async function fullSync(conn: StoredConnection): Promise<{ items: GCalEvent[]; nextSyncToken: string }> {
  const calendar = createCalendarClient(conn);
  return paginate(async (pageToken) => {
    const res = await calendar.events.list({
      calendarId: conn.googleCalendarId,
      singleEvents: true,
      maxResults: 2500,
      timeMin: new Date().toISOString(),
      pageToken,
    });
    return {
      items: (res.data.items ?? []) as RawEvent[],
      nextPageToken: res.data.nextPageToken ?? undefined,
      nextSyncToken: res.data.nextSyncToken ?? undefined,
    };
  });
}

export async function incrementalSync(conn: StoredConnection, syncToken: string): Promise<{ items: GCalEvent[]; nextSyncToken: string }> {
  const calendar = createCalendarClient(conn);
  return paginate(async (pageToken) => {
    const res = await calendar.events.list({
      calendarId: conn.googleCalendarId,
      syncToken,
      maxResults: 2500,
      pageToken,
    });
    return {
      items: (res.data.items ?? []) as RawEvent[],
      nextPageToken: res.data.nextPageToken ?? undefined,
      nextSyncToken: res.data.nextSyncToken ?? undefined,
    };
  });
}

export function isGoneError(err: unknown): boolean {
  const e = err as { code?: number | string; response?: { status?: number }; status?: number } | null;
  if (!e) return false;
  return e.code === 410 || e.response?.status === 410 || e.status === 410;
}

