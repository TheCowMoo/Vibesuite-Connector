export type VideoProvider = 'zoom' | 'google_meet' | 'webinargeek';

export type SessionType = 'meeting' | 'webinar';

export interface AttendeeRecord {
  email?: string;
  name?: string;
  joinedAt?: string;
  leftAt?: string;
  durationSec?: number;
  attentivenessScore?: number;
  isGuest?: boolean;
  registrantId?: string;
  userId?: string;
  participantId?: string;
  customerKey?: string;
  raw?: Record<string, unknown>;
}

export interface PollResult {
  id?: string;
  title?: string;
  [key: string]: unknown;
}

export interface QaEntry {
  id?: string;
  name?: string;
  email?: string;
  question?: string;
  answer?: string;
  [key: string]: unknown;
}

/** One attempt to read a call, kept so "why is this pending?" has an answer. */
export interface SyncAttempt {
  type: SessionType;
  /** Which Zoom host asked (email or user id), or `server-to-server`. */
  host?: string;
  /** HTTP status of the report participants call; undefined when that path was skipped. */
  reportStatus?: number;
  /** HTTP status of the past-call participants fallback; undefined when the report already answered. */
  pastStatus?: number;
  /** Zoom's own message, when it gave one. */
  detail?: string;
}

/** What the provider tried during the last sync, stored on the session for the panel. */
export interface SyncDiagnostics {
  at: number;
  /** The ID actually used, after unwrapping a pasted link. */
  externalId: string;
  /** Type of the attempt that produced this result. */
  sessionType: SessionType;
  /** Host that produced this result. */
  host?: string;
  attempts: SyncAttempt[];
  /** Hosts probed during recovery, with the status of their past-call lookup. */
  hostSweep?: Array<{ host: string; type: SessionType; status: number }>;
}

/** What the provider had to change to make the call readable. */
export interface ProviderCorrection {
  externalId?: string;
  sessionType?: SessionType;
  zoomUserId?: string;
}

/** Everything a provider can extract for a finished session. */
export interface ProviderFetchResult {
  attendees: AttendeeRecord[];
  absentees: string[];
  registrants: number;
  sessionStats: Record<string, string>;
  polls: PollResult[];
  qa: QaEntry[];
  /**
   * Non-fatal explanations for anything that came back empty on purpose — e.g. a user-managed Zoom
   * authorisation without report access has no polls or Q&A. Surfaced on the session so an empty
   * section is explained instead of looking broken.
   */
  notes?: string[];
  /**
   * False when the provider could not read the call at all yet (report not published, call not ended).
   * The session stays `pending` so the scheduler retries, instead of storing an empty report that would
   * look like nobody attended.
   */
  reportReady?: boolean;
  /** Wrong ID form, call type or host that the provider recovered from. Applied by the caller. */
  correction?: ProviderCorrection;
  /** What was tried and what Zoom answered — shown in the panel when a call will not sync. */
  diagnostics?: SyncDiagnostics;
}

/** Which tenant a session belongs to, and which video host owns it. */
export interface VideoAuthContext {
  connectionId?: string;
  zoomUserId?: string;
}

export interface VideoProviderImpl {
  key: VideoProvider;
  fetch(externalId: string, sessionType?: SessionType, ctx?: VideoAuthContext): Promise<ProviderFetchResult>;
  test(ctx?: VideoAuthContext): Promise<{ ok: boolean; detail?: string }>;
  /**
   * The shareable join link, if the provider can supply it *before* the session runs. Optional:
   * the report-based `fetch()` above only exists after the fact, so most providers will not have
   * anything to offer here.
   */
  resolveJoinUrl?(externalId: string, sessionType?: SessionType, ctx?: VideoAuthContext): Promise<string | undefined>;
}
