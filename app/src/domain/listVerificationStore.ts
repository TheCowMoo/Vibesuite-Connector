import { redis } from '../queue/connection';
import { REDIS_KEYS } from '../config/constants';
import {
  normalizeVerificationEmail,
  type StoredEmailVerification,
} from './emailVerificationStore';

export type ListVerificationState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface ListVerificationCounts {
  total: number;
  checked: number;
  cached: number;
  deliverable: number;
  undeliverable: number;
  doNotSend: number;
  catchAll: number;
  unknown: number;
  errors: number;
  unchecked: number;
  billableChecks: number;
}

export interface ListVerificationStatus extends ListVerificationCounts {
  status: ListVerificationState;
  runId: string;
  listId: string;
  connectionId: string;
  locationId: string;
  segments?: string[];
  maxChecks: number;
  estimatedCostUsd: number;
  jobId?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  lastError?: string;
  cancelRequested?: boolean;
  warnings?: string[];
}

function parseStatus(raw: string | null | undefined): ListVerificationStatus | null {
  if (!raw) return null;
  try {
    const status = JSON.parse(raw) as ListVerificationStatus;
    if (!status || typeof status !== 'object' || !status.status || !status.runId) return null;
    if (!status.listId || !status.connectionId) return null;
    return status;
  } catch {
    return null;
  }
}

export async function getListVerificationStatus(id: string): Promise<ListVerificationStatus | null> {
  return parseStatus(await redis.get(REDIS_KEYS.listVerifyStatus(id)));
}

export async function getListVerificationStatuses(
  ids: string[],
): Promise<Record<string, ListVerificationStatus | null>> {
  if (!ids.length) return {};
  const values = await redis.mget(ids.map((id) => REDIS_KEYS.listVerifyStatus(id)));
  const out: Record<string, ListVerificationStatus | null> = {};
  ids.forEach((id, index) => {
    out[id] = parseStatus(values[index]);
  });
  return out;
}

export async function saveListVerificationStatus(
  id: string,
  status: ListVerificationStatus,
): Promise<void> {
  await redis.set(REDIS_KEYS.listVerifyStatus(id), JSON.stringify(status));
}

export async function updateListVerificationStatus(
  id: string,
  patch: Partial<ListVerificationStatus>,
): Promise<ListVerificationStatus | null> {
  const current = await getListVerificationStatus(id);
  if (!current) return null;
  const next: ListVerificationStatus = { ...current, ...patch };
  await saveListVerificationStatus(id, next);
  return next;
}

export async function saveListVerificationResults(
  id: string,
  results: StoredEmailVerification[],
): Promise<void> {
  if (!results.length) return;
  const pipe = redis.pipeline();
  for (const result of results) {
    const email = normalizeVerificationEmail(result.address);
    if (!email) continue;
    pipe.hset(REDIS_KEYS.listVerifyResults(id), email, JSON.stringify({ ...result, address: email }));
  }
  await pipe.exec();
}

function parseResult(raw: string | null | undefined): StoredEmailVerification | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as StoredEmailVerification;
    if (!value || !value.address || !value.result || !value.risk) return null;
    return value;
  } catch {
    return null;
  }
}

export async function getListVerificationResults(
  id: string,
  emails?: string[],
): Promise<Map<string, StoredEmailVerification>> {
  const out = new Map<string, StoredEmailVerification>();
  if (emails && !emails.length) return out;
  const key = REDIS_KEYS.listVerifyResults(id);

  if (emails) {
    const unique = Array.from(new Set(emails.map(normalizeVerificationEmail).filter(Boolean)));
    if (!unique.length) return out;
    const values = await redis.hmget(key, ...unique);
    unique.forEach((email, index) => {
      const value = parseResult(values[index]);
      if (value) out.set(email, value);
    });
    return out;
  }

  const raw = await redis.hgetall(key);
  for (const value of Object.values(raw)) {
    const parsed = parseResult(value);
    if (parsed) out.set(normalizeVerificationEmail(parsed.address), parsed);
  }
  return out;
}

export async function deleteListVerification(id: string): Promise<void> {
  await redis.del(REDIS_KEYS.listVerifyStatus(id), REDIS_KEYS.listVerifyResults(id));
}

export async function saveCampaignVerificationResults(
  id: string,
  results: StoredEmailVerification[],
): Promise<void> {
  if (!results.length) return;
  const pipe = redis.pipeline();
  for (const result of results) {
    const email = normalizeVerificationEmail(result.address);
    if (!email) continue;
    pipe.hset(REDIS_KEYS.campaignVerifyResults(id), email, JSON.stringify({ ...result, address: email }));
  }
  await pipe.exec();
}

export async function getCampaignVerificationResults(
  id: string,
  emails?: string[],
): Promise<Map<string, StoredEmailVerification>> {
  const out = new Map<string, StoredEmailVerification>();
  if (emails && !emails.length) return out;
  const key = REDIS_KEYS.campaignVerifyResults(id);

  if (emails) {
    const unique = Array.from(new Set(emails.map(normalizeVerificationEmail).filter(Boolean)));
    if (!unique.length) return out;
    const values = await redis.hmget(key, ...unique);
    unique.forEach((email, index) => {
      const value = parseResult(values[index]);
      if (value) out.set(email, value);
    });
    return out;
  }

  const raw = await redis.hgetall(key);
  for (const value of Object.values(raw)) {
    const parsed = parseResult(value);
    if (parsed) out.set(normalizeVerificationEmail(parsed.address), parsed);
  }
  return out;
}

export async function saveCampaignVerificationAudience(id: string, emails: string[]): Promise<void> {
  const unique = Array.from(new Set(emails.map(normalizeVerificationEmail).filter(Boolean)));
  await redis.set(REDIS_KEYS.campaignVerifyAudience(id), JSON.stringify(unique));
}

export async function getCampaignVerificationAudience(id: string): Promise<string[]> {
  const raw = await redis.get(REDIS_KEYS.campaignVerifyAudience(id));
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.map((email) => normalizeVerificationEmail(String(email))).filter(Boolean);
  } catch {
    return [];
  }
}

export async function clearCampaignVerification(id: string): Promise<void> {
  await redis.del(
    REDIS_KEYS.campaignVerifyResults(id),
    REDIS_KEYS.campaignVerifyAudience(id),
  );
}
