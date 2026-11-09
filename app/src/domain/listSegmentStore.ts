import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import { env } from '../config/env';
import type { BatchResult, TaxonomySegment } from './listSegmentBatch';

export type ListSegmentState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ListSegmentationStatus {
  status: ListSegmentState;
  runId: string;
  totalRows: number;
  processedRows: number;
  totalBatches: number;
  processedBatches: number;
  jobId?: string;
  taxonomy?: TaxonomySegment[];
  warnings?: string[];
  error?: string;
  cancelRequested?: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

const STATUS_TTL_SECONDS = env.LIST_SEGMENT_STATUS_TTL_HOURS * 60 * 60;
const CHECKPOINT_TTL_SECONDS = env.LIST_SEGMENT_CHECKPOINT_TTL_HOURS * 60 * 60;

function parseStatus(raw: string | null | undefined): ListSegmentationStatus | null {
  if (!raw) return null;
  try {
    const status = JSON.parse(raw) as ListSegmentationStatus;
    if (!status || typeof status !== 'object' || !status.status || !status.runId) return null;
    return status;
  } catch {
    return null;
  }
}

export async function getListSegmentStatus(id: string): Promise<ListSegmentationStatus | null> {
  return parseStatus(await redis.get(REDIS_KEYS.listSegmentStatus(id)));
}

export async function getListSegmentStatuses(
  ids: string[],
): Promise<Record<string, ListSegmentationStatus | null>> {
  if (!ids.length) return {};
  const values = await redis.mget(ids.map((id) => REDIS_KEYS.listSegmentStatus(id)));
  const out: Record<string, ListSegmentationStatus | null> = {};
  ids.forEach((id, index) => {
    out[id] = parseStatus(values[index]);
  });
  return out;
}

export async function saveListSegmentStatus(
  id: string,
  status: ListSegmentationStatus,
): Promise<void> {
  await redis.set(REDIS_KEYS.listSegmentStatus(id), JSON.stringify(status), 'EX', STATUS_TTL_SECONDS);
}

export async function updateListSegmentStatus(
  id: string,
  patch: Partial<ListSegmentationStatus>,
): Promise<ListSegmentationStatus | null> {
  const current = await getListSegmentStatus(id);
  if (!current) return null;
  const next: ListSegmentationStatus = { ...current, ...patch };
  await saveListSegmentStatus(id, next);
  return next;
}

export async function saveListSegmentBatch(
  id: string,
  runId: string,
  result: BatchResult,
): Promise<void> {
  const key = REDIS_KEYS.listSegmentBatches(id, runId);
  await redis.hset(key, String(result.index), JSON.stringify(result));
  await redis.expire(key, CHECKPOINT_TTL_SECONDS);
}

function parseBatchResult(raw: string | undefined): BatchResult | null {
  if (!raw) return null;
  try {
    const result = JSON.parse(raw) as BatchResult;
    if (
      !result ||
      !Number.isInteger(result.index) ||
      !Number.isInteger(result.offset) ||
      !Number.isInteger(result.rowCount) ||
      !Array.isArray(result.assignments)
    ) {
      return null;
    }
    return { ...result, warnings: Array.isArray(result.warnings) ? result.warnings : [] };
  } catch {
    return null;
  }
}

export async function getListSegmentBatches(id: string, runId: string): Promise<BatchResult[]> {
  const raw = await redis.hgetall(REDIS_KEYS.listSegmentBatches(id, runId));
  return Object.values(raw)
    .map(parseBatchResult)
    .filter((result): result is BatchResult => result != null)
    .sort((a, b) => a.index - b.index);
}

export async function deleteListSegmentBatches(id: string, runId: string): Promise<void> {
  await redis.del(REDIS_KEYS.listSegmentBatches(id, runId));
}

export async function deleteListSegmentation(id: string): Promise<void> {
  const status = await getListSegmentStatus(id);
  const multi = redis.multi().del(REDIS_KEYS.listSegmentStatus(id));
  if (status?.runId) multi.del(REDIS_KEYS.listSegmentBatches(id, status.runId));
  await multi.exec();
}
