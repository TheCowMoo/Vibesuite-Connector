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
} as const;

