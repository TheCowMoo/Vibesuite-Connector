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
} as const;

