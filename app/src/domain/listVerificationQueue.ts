import { randomUUID } from 'node:crypto';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { emailVerifyQueue } from '../queue/queues';
import type { EmailVerifyJobData } from '../queue/jobs/types';
import { getConnection } from './connectionStore';
import { extractRecipients } from './invite';
import { getList } from './listStore';
import { estimateVerificationCostUsd } from './emailVerificationPolicy';
import {
  deleteListVerification,
  getListVerificationStatus,
  getListVerificationStatuses,
  saveListVerificationStatus,
  updateListVerificationStatus,
  type ListVerificationStatus,
} from './listVerificationStore';

export { deleteListVerification, getListVerificationStatus, getListVerificationStatuses };

export interface EnqueueListVerificationOptions {
  connectionId: string;
  segments?: string[];
  maxChecks?: number;
}

function cleanSegments(segments?: string[]): string[] | undefined {
  const cleaned = (segments || []).map((s) => String(s || '').trim()).filter(Boolean);
  return cleaned.length ? Array.from(new Set(cleaned)) : undefined;
}

/**
 * Queue one list-wide GHL verification run.
 *
 * The job is deliberately explicit about the paying connection: GHL deducts each check from that
 * location (or the company wallet). The global cache means re-running only pays for new addresses.
 */
export async function enqueueListVerification(
  listId: string,
  options: EnqueueListVerificationOptions,
): Promise<ListVerificationStatus> {
  const rec = await getList(listId);
  if (!rec) throw new Error('list not found');
  if (!rec.result) throw new Error('list has no segmentation result — run Segment first');

  const connectionId = String(options.connectionId || '').trim();
  if (!connectionId) throw new Error('choose a GHL connection to pay for verification');
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error('GHL connection not found');
  if (!conn.ghlLocationId) throw new Error('that GHL connection has no location id');

  const segments = cleanSegments(options.segments);
  const plan = extractRecipients(rec.result, segments);
  if (!plan.emails.length) throw new Error('this list has no usable email addresses to verify');

  const current = await getListVerificationStatus(listId);
  if (current && (current.status === 'queued' || current.status === 'running')) {
    return current;
  }

  const requested = Number(options.maxChecks);
  const requestedCap = Number.isFinite(requested) ? Math.floor(requested) : env.EMAIL_VERIFY_MAX_PER_RUN;
  const maxChecks = Math.min(
    env.EMAIL_VERIFY_MAX_PER_RUN,
    Math.max(1, requestedCap || env.EMAIL_VERIFY_MAX_PER_RUN),
  );

  const runId = randomUUID();
  const now = Date.now();
  const status: ListVerificationStatus = {
    status: 'queued',
    runId,
    listId,
    connectionId,
    locationId: conn.ghlLocationId,
    ...(segments ? { segments } : {}),
    maxChecks,
    total: plan.emails.length,
    checked: 0,
    cached: 0,
    deliverable: 0,
    undeliverable: 0,
    doNotSend: 0,
    catchAll: 0,
    unknown: 0,
    errors: 0,
    unchecked: plan.emails.length,
    billableChecks: 0,
    estimatedCostUsd: estimateVerificationCostUsd(
      Math.min(plan.emails.length, maxChecks),
      env.EMAIL_VERIFY_COST_PER_1000,
    ),
    createdAt: now,
  };

  const jobId = `email-verify-${listId}-${runId}-${now}`;
  status.jobId = jobId;
  await saveListVerificationStatus(listId, status);

  try {
    const data: EmailVerifyJobData = {
      listId,
      runId,
      connectionId,
      locationId: conn.ghlLocationId,
      ...(segments ? { segments } : {}),
      maxChecks,
    };
    await emailVerifyQueue.add('verify-list', data, { jobId });
  } catch (err) {
    const message = (err as Error).message || 'could not queue email verification';
    await updateListVerificationStatus(listId, {
      status: 'failed',
      error: message,
      finishedAt: Date.now(),
    });
    logger.error({ err, listId }, 'could not enqueue list email verification');
    throw err;
  }

  return status;
}

export async function cancelListVerification(
  listId: string,
): Promise<ListVerificationStatus | null> {
  const current = await getListVerificationStatus(listId);
  if (!current) return null;
  if (current.status !== 'queued' && current.status !== 'running') return current;

  // The worker checks this flag between chunks. A queued job that has not started is finished
  // immediately so the UI does not sit on a run that will never begin.
  return updateListVerificationStatus(listId, {
    status: current.status === 'queued' ? 'cancelled' : current.status,
    cancelRequested: true,
    ...(current.status === 'queued' ? { finishedAt: Date.now() } : {}),
  });
}
