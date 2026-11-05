import { randomUUID } from 'node:crypto';
import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import type { SessionType, SyncDiagnostics, VideoProvider } from '../video/types';

export type SessionStatus = 'pending' | 'synced' | 'failed';

export type WorkflowAssignmentSource = 'rule' | 'ai' | 'manual';
export type WorkflowAssignmentStatus = 'applied' | 'skipped' | 'failed';

/** One real attempt to put a contact into a GHL workflow. */
export interface WorkflowAssignmentRecord {
  email?: string;
  name?: string;
  workflowId: string;
  workflowName?: string;
  source: WorkflowAssignmentSource;
  ruleId?: string;
  confidence?: number;
  reason?: string;
  status: WorkflowAssignmentStatus;
  error?: string;
  at: number;
}

/** A proposal shown before the operator applies it. */
export interface WorkflowPreviewAssignment {
  email?: string;
  name?: string;
  workflowId: string | null;
  workflowName?: string;
  source: 'rule' | 'ai';
  ruleId?: string;
  confidence?: number;
  reason?: string;
  eligible: boolean;
}

export interface WorkflowPreview {
  generatedAt: number;
  behaviorHash: string;
  assignments: WorkflowPreviewAssignment[];
  rejected?: string[];
  error?: string;
}

export interface SessionRecord {
  id: string;
  provider: VideoProvider;
  sessionType?: SessionType;
  externalId: string;
  joinUrl?: string;
  title: string;
  connectionId?: string;
  /** Which authorised Zoom host owns this session (user-managed Zoom auth). */
  zoomUserId?: string;
  inviteId?: string;
  listId?: string;
  startTime: string;
  endTime: string;
  status: SessionStatus;
  lastSyncedAt?: number;
  error?: string;
  /** Non-fatal notes from the provider, e.g. why polls and Q&A are empty. */
  warnings?: string[];
  /** What the last sync tried, so a session that will not sync can explain itself in the panel. */
  syncDiagnostics?: SyncDiagnostics;
  /** Last roster revision delivered successfully; an unchanged result is not resent. */
  rosterRevision?: string;
  rosterSentAt?: number;
  /** When "Send results" last ran for this call (tags, workflows, webhooks, export). */
  lastDispatchedAt?: number;
  /** Why the last roster delivery failed — surfaced so it is not a silent loss. */
  rosterError?: string;
  /** Every workflow assignment attempt, newest first, for the session detail. */
  workflowAssignments?: WorkflowAssignmentRecord[];
  /** Last AI/deterministic proposal set, kept so the operator can review it. */
  workflowPreview?: WorkflowPreview;
  workflowAssignedAt?: number;
  /** Content hash of the last automatic AI routing run; an unchanged report is not re-sent. */
  workflowAiHash?: string;
  samplePayload?: unknown;
  createdAt: number;
}

export async function createSession(input: Omit<SessionRecord, 'id' | 'status' | 'createdAt'>): Promise<SessionRecord> {
  const rec: SessionRecord = { ...input, id: randomUUID(), status: 'pending', createdAt: Date.now() };
  await redis
    .multi()
    .sadd(REDIS_KEYS.sessionsIndex(), rec.id)
    .set(REDIS_KEYS.session(rec.id), JSON.stringify(rec))
    .exec();
  return rec;
}

export async function getSession(id: string): Promise<SessionRecord | null> {
  const raw = await redis.get(REDIS_KEYS.session(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

export async function saveSession(rec: SessionRecord): Promise<void> {
  await redis.set(REDIS_KEYS.session(rec.id), JSON.stringify(rec));
}

export async function listSessions(): Promise<SessionRecord[]> {
  const ids = await redis.smembers(REDIS_KEYS.sessionsIndex());
  const recs = await Promise.all(
    ids.map(async (id) => {
      const raw = await redis.get(REDIS_KEYS.session(id));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SessionRecord;
      } catch {
        return null;
      }
    })
  );
  return recs.filter((r): r is SessionRecord => r !== null).sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteSession(id: string): Promise<void> {
  await redis
    .multi()
    .srem(REDIS_KEYS.sessionsIndex(), id)
    .del(REDIS_KEYS.session(id))
    .del(REDIS_KEYS.attendance(id))
    .exec();
}
