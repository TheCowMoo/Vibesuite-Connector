export interface SyncJobData {
  connectionId: string;
  resourceId?: string;
  resourceUri?: string;
  resourceState: 'sync' | 'exists' | 'not_exists';
  messageNumber?: string;
  receivedAt: number;
}

export interface ListSegmentJobData {
  listId: string;
  runId: string;
}

export interface EmailVerifyJobData {
  listId: string;
  runId: string;
  connectionId: string;
  locationId: string;
  segments?: string[];
  maxChecks: number;
}

