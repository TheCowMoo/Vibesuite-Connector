export type GoogleResponseStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction';

export interface GCalAttendee {
  email: string;
  responseStatus?: GoogleResponseStatus | string;
  displayName?: string;
}

export interface GCalEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface GCalEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  start?: GCalEventTime;
  end?: GCalEventTime;
  attendees?: GCalAttendee[];
  updated?: string;
}
