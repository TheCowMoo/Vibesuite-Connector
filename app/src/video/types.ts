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
