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
}

export interface VideoProviderImpl {
  key: VideoProvider;
  fetch(externalId: string, sessionType?: SessionType): Promise<ProviderFetchResult>;
  test(): Promise<{ ok: boolean; detail?: string }>;
  /**
   * The shareable join link, if the provider can supply it *before* the session runs. Optional:
   * the report-based `fetch()` above only exists after the fact, so most providers will not have
   * anything to offer here.
   */
  resolveJoinUrl?(externalId: string, sessionType?: SessionType): Promise<string | undefined>;
}
