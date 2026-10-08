export type GoogleAuthType = 'oauth' | 'service_account';
export type GhlAuthType = 'oauth' | 'api_token';
export type ConnectionStatus = 'pending_google' | 'active' | 'disconnected';

export interface WebhookUrls {
  yes?: string;
  maybe?: string;
  no?: string;
}

export type DeliveryMode = 'api' | 'webhook' | 'both';

export type ConditionField = 'responseStatus' | 'email' | 'eventSummary' | 'eventId' | 'calendarId';
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'is_empty'
  | 'not_empty';

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
  watchChannelId?: string;
  watchExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionSecrets {
  googleRefreshToken?: string;
  googleServiceAccountKey?: string;
  ghlAccessToken?: string;
  ghlRefreshToken?: string;
  ghlApiToken?: string;
}

export type StoredConnection = Connection & ConnectionSecrets;
