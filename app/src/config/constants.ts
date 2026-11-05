import { env } from './env';

export const QUEUE_NAMES = {
  sync: env.SYNC_QUEUE_NAME,
} as const;

export const JOB_NAMES = {
  processSync: 'process-sync',
} as const;

export const REDIS_KEYS = {
  connectionsIndex: () => 'connections',
  connection: (id: string) => `conn:${id}:meta`,
  connectionSecrets: (id: string) => `conn:${id}:secrets`,
  oauthState: (state: string) => `oauth:state:${state}`,

  syncToken: (connectionId: string) => `conn:${connectionId}:sync:token`,
  stateHash: (connectionId: string) => `conn:${connectionId}:sync:state`,
  /** Per-event RSVP history: hash email -> JSON[{status, at, initial?}]. */
  rsvpHistory: (connectionId: string, eventId: string) => `conn:${connectionId}:rsvp:history:${eventId}`,
  lock: (connectionId: string) => `conn:${connectionId}:lock`,
  dispatched: (connectionId: string, fingerprint: string) => `conn:${connectionId}:dispatch:seen:${fingerprint}`,

  watchByChannel: (channelId: string) => `watch:byChannel:${channelId}`,
  watchByConnection: (connectionId: string) => `conn:${connectionId}:watch:channel`,

  mapEvent: (connectionId: string, eventId: string) => `conn:${connectionId}:map:event:${eventId}`,
  mapContact: (connectionId: string, email: string) => `conn:${connectionId}:map:contact:${email.toLowerCase()}`,
  snapshot: (connectionId: string) => `conn:${connectionId}:snapshot`,
  aiSettings: () => 'settings:ai',
  knowledgeIndex: () => 'knowledge:index',
  knowledgeDoc: (id: string) => `knowledge:doc:${id}`,
  listsIndex: () => 'lists:index',
  list: (id: string) => `list:${id}`,
  invitesIndex: () => 'invites:index',
  invite: (id: string) => `invite:${id}`,
  listInvites: (listId: string) => `list:${listId}:invites`,
  listInvited: (listId: string) => `list:${listId}:invited`,
  listInvitedMeta: (listId: string) => `list:${listId}:invitedMeta`,
  inviteSchedulesIndex: () => 'invite:schedules',
  inviteSchedule: (id: string) => `invite:schedule:${id}`,
  videoSettings: () => 'settings:video',
  /** Authorised Zoom hosts, shared by every campaign that picks them. */
  zoomAccountsIndex: () => 'zoom:accounts',
  zoomAccount: (userId: string) => `zoom:account:${userId}`,
  zoomAccountTokens: (userId: string) => `zoom:account:${userId}:tokens`,
  sessionsIndex: () => 'sessions:index',
  session: (id: string) => `session:${id}`,
  attendance: (sessionId: string) => `session:${sessionId}:attendance`,
  attendanceDispatched: (sessionId: string, fingerprint: string) => `session:${sessionId}:dispatch:seen:${fingerprint}`,
  /** The workflow already applied to one person in one session (30-day marker). */
  attendanceWorkflowChosen: (sessionId: string, identity: string) => `session:${sessionId}:workflow:${identity}`,
  /** Short lock around one person's workflow application. */
  attendanceWorkflowLock: (sessionId: string, identity: string) => `session:${sessionId}:workflow:lock:${identity}`,
  authUser: (id: string) => `auth:user:${id}`,
  authUsers: () => 'auth:users',
  authEmail: (emailLower: string) => `auth:email:${emailLower}`,
  authInvite: (id: string) => `auth:invite:${id}`,
  authInvites: () => 'auth:invites',
  authSession: (tokenHash: string) => `auth:session:${tokenHash}`,
  authLogins: (userId: string) => `auth:logins:${userId}`,
  authLoginAttempts: (key: string) => `auth:loginAttempts:${key}`,
  authAudit: () => 'auth:audit',
  teamSettings: () => 'settings:team',
  systemEmailSettings: () => 'settings:systemEmail',
  senderProfile: (connectionId: string) => `sender:profile:${connectionId}`,
  senderProfiles: () => 'sender:profiles',
  senderDay: (connectionId: string, date: string) => `sender:day:${connectionId}:${date}`,
  senderHour: (connectionId: string, hour: string) => `sender:hour:${connectionId}:${hour}`,
  senderState: (connectionId: string) => `sender:state:${connectionId}`,
  campaign: (id: string) => `campaign:${id}`,
  campaignsIndex: () => 'campaigns:index',
  campaignRecipients: (id: string) => `campaign:${id}:recipients`,
  campaignVariantMap: (id: string) => `campaign:${id}:variants`,
  campaignTestEvent: (connectionId: string, eventId: string) => `campaign:test-event:${connectionId}:${eventId}`,
  campaignTestCopyLock: (id: string) => `campaign:${id}:test-copy-lock`,
  campaignQueue: (id: string, connectionId: string) => `campaign:${id}:queue:${connectionId}`,
  campaignSender: (id: string, connectionId: string) => `campaign:${id}:sender:${connectionId}`,
  campaignDispatched: (id: string, email: string) => `campaign:${id}:dispatch:${email.toLowerCase()}`,
  /** Campaign CRM notes/follow-up: hash personKey -> JSON. */
  campaignCrmNotes: (id: string) => `campaign:${id}:crm:notes`,
  /** Cache of DNS-based domain reputation, one key per sending domain. */
  domainHealth: (domain: string) => `domain:health:${domain}`,
  domainHealthIndex: () => 'domain:health:index',
  domainHealthLock: (domain: string) => `domain:health:lock:${domain}`,
  /** The real address behind a `primary` or resource calendar (24-hour TTL). */
  calendarEmail: (connectionId: string) => `conn:${connectionId}:calendarEmail`,
  advisorAnalysis: () => 'advisor:analysis',
  advisorApplyLog: () => 'advisor:applyLog',
} as const;

