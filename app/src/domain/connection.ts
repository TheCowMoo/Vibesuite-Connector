export type GoogleAuthType = 'oauth' | 'service_account';
export type GhlAuthType = 'oauth' | 'api_token';
export type ConnectionStatus = 'pending_google' | 'active' | 'disconnected';

export interface WebhookUrls {
  yes?: string;
  maybe?: string;
  no?: string;
}

export type DeliveryMode = 'api' | 'webhook' | 'both';

/** Which GHL tag each attendance segment gets. Blank falls back to the env defaults. */
export interface AttendanceTags {
  attended?: string;
  partial?: string;
  noShow?: string;
  notInvited?: string;
}

export interface AttendanceRosterSettings {
  /** Where the segmented roster is POSTed. Empty disables roster delivery. */
  url?: string;
  /** One request per segment, or one request containing every segment. */
  shape?: 'segments' | 'session';
}

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

/** A GHL workflow the operator has made available to attendance routing. */
export interface WorkflowTarget {
  /** Local id for the UI; stable if the workflow is renamed. */
  id: string;
  /** GHL workflow id used by POST /contacts/:contactId/workflow/:workflowId. */
  workflowId: string;
  name: string;
  /** Plain-English guidance shown to the AI router. */
  criteria?: string;
}

export type PollConditionOperator =
  | 'answered'
  | 'not_answered'
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains';

export interface PollCondition {
  question: string;
  operator: PollConditionOperator;
  answer?: string;
}

/**
 * One deterministic workflow rule. Rules are checked in order; the first enabled match wins.
 * Every entry in `conditions` and `pollConditions` must match (AND).
 */
export interface AttendanceWorkflowRule {
  id: string;
  name: string;
  enabled: boolean;
  conditions: Condition[];
  pollConditions?: PollCondition[];
  workflowId: string;
  eventStartTime?: 'now' | 'session_start';
}

export interface AttendanceAiWorkflowSettings {
  enabled: boolean;
  mode: 'preview' | 'auto';
  /** 0–1. Proposals below this are shown but not applied. */
  confidenceThreshold: number;
  /** 0 means every attendee. A positive number caps AI cost per session. */
  maxAttendees: number;
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
  /** Per-segment GHL tags; env defaults fill the blanks. */
  attendanceTags?: AttendanceTags;
  /** Optional GHL custom field that receives the segment name. */
  attendanceCustomFieldId?: string;
  /** GHL workflows that attendance rules (and the AI router) may assign. */
  attendanceWorkflows?: WorkflowTarget[];
  /** Deterministic poll/stat rules; first enabled match wins. */
  attendanceWorkflowRules?: AttendanceWorkflowRule[];
  /** Optional AI routing on top of the deterministic rules. */
  attendanceAiWorkflow?: AttendanceAiWorkflowSettings;
  /** External roster webhook for the full segmented result. */
  attendanceRoster?: AttendanceRosterSettings;
  /** True when a roster bearer token is stored (the token itself is encrypted, never returned). */
  attendanceRosterTokenSet?: boolean;
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
  /** Never leaves the server; `publicConnection` only exposes whether it is set. */
  attendanceRosterToken?: string;
}

export type StoredConnection = Connection & ConnectionSecrets;
