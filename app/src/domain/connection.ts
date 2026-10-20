export type GoogleAuthType = 'oauth' | 'service_account';
export type GhlAuthType = 'oauth' | 'api_token';
export type ConnectionStatus = 'pending_google' | 'active' | 'disconnected';

export type ZoomAuthMode = 's2s' | 'user';

/**
 * One Zoom account authorised for this connection, via the user-managed General App.
 *
 * `reportAccess` records what Zoom actually allowed, because a user-managed app authorised by a
 * non-admin host cannot read `/report/*`: attendance still syncs from the past-meetings API, but
 * polls, Q&A and the absentee list are unavailable. Caching the answer means we do not re-probe on
 * every sync, and the UI can say why rather than looking broken.
 */
export interface ZoomAccountLink {
  userId: string;
  email: string;
  displayName?: string;
  connectedAt: number;
  reportAccess: 'granted' | 'denied' | 'unknown';
}

export interface ZoomTokenSet {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface WebhookUrls {
  yes?: string;
  maybe?: string;
  no?: string;
}

export type DeliveryMode = 'api' | 'webhook' | 'both';

export type ConditionField =
  | 'responseStatus'
  | 'email'
  | 'eventSummary'
  | 'eventId'
  | 'calendarId'
  | 'attendanceStatus'
  | 'attendanceMinutes'
  | 'provider'
  | 'sessionTitle'
  | 'sessionId'
  | 'joinedAt'
  | 'leftAt'
  // Allows any provider-extracted stat to be used as a condition without
  // widening this union by hand (keeps autocomplete for the literals above).
  | (string & {});
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'not_empty'
  | 'greater_than'
  | 'greater_or_equal'
  | 'less_than'
  | 'less_or_equal';

export interface Condition {
  field: ConditionField;
  operator: ConditionOperator;
  value?: string;
}

export interface AutomationRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: Condition[];
  webhookUrl: string;
}

export interface Connection {
  id: string;
  name: string;
  status: ConnectionStatus;
  googleCalendarId: string;
  googleAuthType: GoogleAuthType;
  googleServiceAccountEmail?: string;
  googleSubject?: string;
  ghlAuthType: GhlAuthType;
  ghlLocationId: string;
  webhookUrls?: WebhookUrls;
  ghlDeliveryMode?: DeliveryMode;
  rules?: AutomationRule[];
  attendanceDeliveryMode?: DeliveryMode;
  attendanceRules?: AutomationRule[];
  watchChannelId?: string;
  watchExpiresAt?: number;
  /** Zoom accounts authorised for this connection (user-managed app). Metadata only — no tokens. */
  zoomAccounts?: ZoomAccountLink[];
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionSecrets {
  googleRefreshToken?: string;
  googleServiceAccountKey?: string;
  ghlAccessToken?: string;
  ghlRefreshToken?: string;
  ghlApiToken?: string;
  /** Per Zoom user id, so one connection can hold several hosts. Encrypted with the rest. */
  zoomTokens?: Record<string, ZoomTokenSet>;
}

export type StoredConnection = Connection & ConnectionSecrets;
