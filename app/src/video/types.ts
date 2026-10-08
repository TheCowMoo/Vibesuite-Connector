export type VideoProvider = 'zoom' | 'google_meet' | 'webinargeek';

export interface AttendeeRecord {
  email?: string;
  name?: string;
  joinedAt?: string;
  leftAt?: string;
  durationSec?: number;
}

export interface VideoProviderImpl {
  key: VideoProvider;
  listAttendees(externalId: string): Promise<AttendeeRecord[]>;
  test(): Promise<{ ok: boolean; detail?: string }>;
}
