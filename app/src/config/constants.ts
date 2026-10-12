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
  videoSettings: () => 'settings:video',
  sessionsIndex: () => 'sessions:index',
  session: (id: string) => `session:${id}`,
  attendance: (sessionId: string) => `session:${sessionId}:attendance`,
  attendanceDispatched: (sessionId: string, fingerprint: string) => `session:${sessionId}:dispatch:seen:${fingerprint}`,
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
  senderProfile: (connectionId: string) => `sender:profile:${connectionId}`,
  senderProfiles: () => 'sender:profiles',
  senderDay: (connectionId: string, date: string) => `sender:day:${connectionId}:${date}`,
  senderHour: (connectionId: string, hour: string) => `sender:hour:${connectionId}:${hour}`,
  senderState: (connectionId: string) => `sender:state:${connectionId}`,
} as const;

