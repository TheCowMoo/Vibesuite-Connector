import { normalizeEmail, type AttendanceReport } from './attendance';
import { getAttendance } from './attendanceStore';
import type { Campaign } from './campaign';
import {
  buildCampaignCrm,
  filterCampaignCrmRows,
  profilesFromList,
  selectCampaignCrmRows,
  type CampaignCrmFilterOptions,
  type CampaignCrmQuery,
  type CampaignCrmRow,
  type CampaignCrmSummary,
} from './campaignCrm';
import { getCampaignCrmNotes } from './campaignNotesStore';
import { getRecipients } from './campaignStore';
import { listConnections } from './connectionStore';
import { getList } from './listStore';
import { ensureRsvpBaseline, getRsvpHistory } from './rsvpHistoryStore';
import type { RsvpHistoryEntry } from './rsvpHistory';
import { getSession, type SessionRecord } from './sessionStore';
import { stateStore } from './stateStore';

export interface CampaignCrmSession {
  id: string;
  title: string;
  provider: string;
  externalId?: string;
  startTime?: string;
  endTime?: string;
  status: string;
  lastSyncedAt?: number;
}

export interface CampaignCrmResponse {
  campaign: {
    id: string;
    name: string;
    status: string;
    listId: string;
    sessionId?: string;
    includeAlreadyInvited: boolean;
    event: Campaign['event'];
    senders: Array<{ connectionId: string; name: string; enabled: boolean; share?: number; quota?: number }>;
  };
  session: CampaignCrmSession | null;
  summary: CampaignCrmSummary;
  filters: CampaignCrmFilterOptions;
  rows: CampaignCrmRow[];
  total: number;
  offset: number;
  limit: number;
  warnings: string[];
  hasAttendance: boolean;
  attendanceGeneratedAt?: number;
}

function sessionFromAttendance(attendance: AttendanceReport, fallbackId: string): CampaignCrmSession {
  return {
    id: fallbackId,
    title: attendance.sessionTitle || 'Linked call',
    provider: attendance.provider,
    startTime: attendance.sessionStart,
    endTime: attendance.sessionEnd,
    status: 'synced',
  };
}

function safeSession(session: SessionRecord): CampaignCrmSession {
  return {
    id: session.id,
    title: session.title,
    provider: session.provider,
    externalId: session.externalId,
    startTime: session.startTime,
    endTime: session.endTime,
    status: session.status,
    ...(session.lastSyncedAt ? { lastSyncedAt: session.lastSyncedAt } : {}),
  };
}

export async function collectCampaignCrm(
  camp: Campaign,
  query: CampaignCrmQuery,
  options: { paginate?: boolean; now?: number } = {},
): Promise<CampaignCrmResponse> {
  const recipients = await getRecipients(camp.id);
  const connectionIds = Array.from(
    new Set([...recipients.map((r) => r.connectionId), ...camp.senders.map((s) => s.connectionId)]),
  );

  const rsvpByConnection: Record<string, Record<string, Record<string, string>>> = {};
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const states = await stateStore.getStates(connectionId);
      const perEvent: Record<string, Record<string, string>> = {};
      for (const [eventId, map] of states) perEvent[eventId] = map;
      rsvpByConnection[connectionId] = perEvent;
    }),
  );

  const [attendance, session, list, notes, connections] = await Promise.all([
    camp.sessionId ? getAttendance(camp.sessionId) : Promise.resolve(null),
    camp.sessionId ? getSession(camp.sessionId) : Promise.resolve(null),
    getList(camp.listId),
    getCampaignCrmNotes(camp.id),
    listConnections(),
  ]);

  const connectionNames: Record<string, string> = {};
  for (const connection of connections) connectionNames[connection.id] = connection.name;

  const profiles = list ? profilesFromList(list.result, camp.segments) : {};
  const now = options.now ?? Date.now();

  // Start a baseline for existing campaigns the first time the CRM is opened. This is the only
  // place that writes from a read route, and it only fills missing entries.
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const entries = recipients
        .filter((rec) => rec.status === 'sent' && rec.eventId && rec.connectionId === connectionId)
        .map((rec) => ({
          eventId: rec.eventId as string,
          email: normalizeEmail(rec.email),
          status: rsvpByConnection[connectionId]?.[rec.eventId as string]?.[normalizeEmail(rec.email)],
        }));
      if (entries.length) await ensureRsvpBaseline(connectionId, entries, now);
    }),
  );

  const history: Record<string, Record<string, RsvpHistoryEntry[]>> = {};
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const eventIds = Array.from(
        new Set(recipients.filter((r) => r.connectionId === connectionId && r.eventId).map((r) => r.eventId as string)),
      );
      if (!eventIds.length) return;
      const index = await getRsvpHistory(connectionId, eventIds);
      for (const [eventId, byEmail] of index) {
        history[`${connectionId}|${eventId}`] = Object.fromEntries(byEmail);
      }
    }),
  );

  const built = buildCampaignCrm({
    campaign: camp,
    recipients,
    rsvpByConnection,
    attendance,
    profiles,
    notes,
    history,
    connectionNames,
  });

  const page = options.paginate === false
    ? (() => {
        const rows = filterCampaignCrmRows(built.rows, query);
        return { rows, total: rows.length, offset: 0, limit: rows.length };
      })()
    : selectCampaignCrmRows(built.rows, query);

  const sessionMeta = session ? safeSession(session) : attendance && camp.sessionId
    ? sessionFromAttendance(attendance, camp.sessionId)
    : null;

  return {
    campaign: {
      id: camp.id,
      name: camp.name,
      status: camp.status,
      listId: camp.listId,
      ...(camp.sessionId ? { sessionId: camp.sessionId } : {}),
      includeAlreadyInvited: camp.includeAlreadyInvited,
      event: camp.event,
      senders: camp.senders.map((sender) => ({
        connectionId: sender.connectionId,
        name: connectionNames[sender.connectionId] || sender.connectionId.slice(0, 8),
        enabled: sender.enabled,
        ...(sender.share !== undefined ? { share: sender.share } : {}),
        ...(sender.quota !== undefined ? { quota: sender.quota } : {}),
      })),
    },
    session: sessionMeta,
    summary: built.summary,
    filters: built.filters,
    rows: page.rows,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    warnings: built.warnings,
    hasAttendance: built.hasAttendance,
    ...(built.attendanceGeneratedAt ? { attendanceGeneratedAt: built.attendanceGeneratedAt } : {}),
  };
}
