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

