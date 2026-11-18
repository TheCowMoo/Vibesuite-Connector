import { env } from '../config/env';
import { logger } from '../lib/logger';
import { forEachLimit } from '../domain/concurrency';
import { getConnection } from '../domain/connectionStore';
import { extractRecipients } from '../domain/invite';
import { getList } from '../domain/listStore';
import { estimateVerificationCostUsd } from '../domain/emailVerificationPolicy';
import {
  getCachedEmailVerifications,
  normalizeVerificationEmail,
  saveCachedEmailVerifications,
  type StoredEmailVerification,
} from '../domain/emailVerificationStore';
import {
  getListVerificationResults,
  getListVerificationStatus,
  saveListVerificationResults,
  saveListVerificationStatus,
  type ListVerificationStatus,
} from '../domain/listVerificationStore';
import {
  describeGhlVerificationError,
  isGhlVerificationFatalError,
  verifyEmailWithGhl,
} from '../ghl/emailVerification';

interface ResultCounts {
  deliverable: number;
  undeliverable: number;
  doNotSend: number;
  catchAll: number;
  unknown: number;
}

function emptyCounts(): ResultCounts {
  return { deliverable: 0, undeliverable: 0, doNotSend: 0, catchAll: 0, unknown: 0 };
}

function addCount(counts: ResultCounts, result: StoredEmailVerification): void {
  if (result.result === 'deliverable') counts.deliverable += 1;
  else if (result.result === 'undeliverable') counts.undeliverable += 1;
  else if (result.result === 'do_not_send') counts.doNotSend += 1;
  else if (result.result === 'catch_all') counts.catchAll += 1;
  else counts.unknown += 1;
}

function countResults(results: Iterable<StoredEmailVerification>): ResultCounts {
  const counts = emptyCounts();
  for (const result of results) addCount(counts, result);
  return counts;
}

function safeError(err: unknown): string {
  return ((err as Error)?.message || String(err || 'unknown error')).slice(0, 500);
}

async function failRun(status: ListVerificationStatus, error: string): Promise<void> {
  await saveListVerificationStatus(status.listId, {
    ...status,
    status: 'failed',
    error,
    lastError: error,
    finishedAt: Date.now(),
  });
}

/**
 * Process one list-wide GHL verification run.
 *
 * Cached results are reused for free. Only uncached addresses are sent to GHL, capped by the run's
 * `maxChecks`, and the status is updated between chunks so the UI can show progress and cancel.
 */
export async function processListVerification(listId: string, runId: string): Promise<void> {
  let status = await getListVerificationStatus(listId);
  if (!status || status.runId !== runId) return;
  if (status.cancelRequested || status.status === 'cancelled') {
    await saveListVerificationStatus(listId, {
      ...status,
      status: 'cancelled',
      finishedAt: Date.now(),
    });
    return;
  }

  const rec = await getList(listId);
  if (!rec) {
    await failRun(status, 'The list was deleted before verification finished.');
    return;
  }
  if (!rec.result) {
    await failRun(status, 'The list has no segmentation result — run Segment first.');
    return;
  }

  const conn = await getConnection(status.connectionId);
  if (!conn) {
    await failRun(status, 'The GHL connection was removed before verification finished.');
    return;
  }
  if (!conn.ghlLocationId) {
    await failRun(status, 'That GHL connection has no location id.');
    return;
  }

  const plan = extractRecipients(rec.result, status.segments);
  const emails = Array.from(
    new Set(plan.emails.map((email) => normalizeVerificationEmail(email)).filter(Boolean)),
  );
  if (!emails.length) {
    await failRun(status, 'This list has no usable email addresses to verify.');
    return;
  }

  const [existing, cached] = await Promise.all([
    getListVerificationResults(listId, emails),
    getCachedEmailVerifications(emails),
  ]);
  const known = new Map<string, StoredEmailVerification>();
  for (const email of emails) {
    const result = existing.get(email) ?? cached.get(email);
    if (result) known.set(email, result);
  }

  // A cache hit is still a real verification result; mirror it into the list snapshot so later
  // reads do not depend on the cache TTL.
  const cacheOnly = Array.from(known.values()).filter(
    (result) => !existing.has(normalizeVerificationEmail(result.address)),
  );
  if (cacheOnly.length) {
    await saveListVerificationResults(listId, cacheOnly).catch((err) => {
      logger.warn({ listId, err: safeError(err) }, 'could not mirror cached email verification results');
    });
  }

  const counts = countResults(known.values());
  const initialKnown = known.size;
  const uncached = emails.filter((email) => !known.has(email));
  const toCheck = uncached.slice(0, Math.max(0, status.maxChecks));
  const capReached = toCheck.length < uncached.length;
  let billableChecks = 0;
  let newlyChecked = 0;
  let errors = 0;
  let lastError: string | undefined;
  let cancelled = false;

  status = {
    ...status,
    status: 'running',
    total: emails.length,
    checked: known.size,
    cached: initialKnown,
    ...counts,
    errors: 0,
    unchecked: Math.max(0, emails.length - known.size),
    billableChecks: 0,
    estimatedCostUsd: estimateVerificationCostUsd(toCheck.length, env.EMAIL_VERIFY_COST_PER_1000),
    startedAt: status.startedAt ?? Date.now(),
    error: undefined,
    lastError: undefined,
    warnings: undefined,
  };
  await saveListVerificationStatus(listId, status);

  const chunkSize = Math.max(1, env.EMAIL_VERIFY_CONCURRENCY * 2);
  try {
    for (let index = 0; index < toCheck.length; index += chunkSize) {
      const fresh = await getListVerificationStatus(listId);
      if (!fresh || fresh.runId !== runId) return;
      if (fresh.cancelRequested || fresh.status === 'cancelled') {
        cancelled = true;
        break;
      }

      const chunk = toCheck.slice(index, index + chunkSize);
      const freshResults: StoredEmailVerification[] = [];
      await forEachLimit(chunk, env.EMAIL_VERIFY_CONCURRENCY, async (email) => {
        billableChecks += 1;
        try {
          const result = await verifyEmailWithGhl(conn, email);
          known.set(normalizeVerificationEmail(result.address), result);
          freshResults.push(result);
          addCount(counts, result);
        } catch (err) {
          if (isGhlVerificationFatalError(err)) throw err;
          errors += 1;
          lastError = safeError(err);
        }
      });

      if (freshResults.length) {
        newlyChecked += freshResults.length;
        await Promise.all([
          saveCachedEmailVerifications(freshResults).catch((err) => {
            logger.warn({ listId, err: safeError(err) }, 'could not cache email verification results');
          }),
          saveListVerificationResults(listId, freshResults).catch((err) => {
            logger.warn({ listId, err: safeError(err) }, 'could not store list email verification results');
          }),
        ]);
      }

      status = {
        ...status,
        total: emails.length,
        checked: known.size,
        cached: Math.max(0, known.size - newlyChecked),
        ...counts,
        errors,
        unchecked: Math.max(0, emails.length - known.size),
        billableChecks,
        estimatedCostUsd: estimateVerificationCostUsd(billableChecks, env.EMAIL_VERIFY_COST_PER_1000),
        lastError,
      };
      await saveListVerificationStatus(listId, status);
    }

    const warnings: string[] = [];
    const remaining = Math.max(0, emails.length - known.size);
    if (cancelled) {
      warnings.push(`${remaining} addresses remain unchecked because the run was cancelled.`);
    } else if (capReached && remaining > 0) {
      warnings.push(
        `${remaining} addresses remain unchecked after the per-run cap. Run verification again to continue; cached results are free.`,
      );
    }
    if (errors > 0) {
      warnings.push(`${errors} checks failed and remain unchecked; run again to retry them.`);
    }

    const finalStatus: ListVerificationStatus = {
      ...status,
      status: cancelled ? 'cancelled' : 'done',
      total: emails.length,
      checked: known.size,
      cached: Math.max(0, known.size - newlyChecked),
      ...counts,
      errors,
      unchecked: remaining,
      billableChecks,
      estimatedCostUsd: estimateVerificationCostUsd(billableChecks, env.EMAIL_VERIFY_COST_PER_1000),
      finishedAt: Date.now(),
      error: undefined,
      lastError,
      ...(warnings.length ? { warnings } : {}),
    };
    await saveListVerificationStatus(listId, finalStatus);
  } catch (err) {
    const fresh = await getListVerificationStatus(listId);
    if (!fresh || fresh.runId !== runId) return;
    const message = describeGhlVerificationError(err);
    await saveListVerificationStatus(listId, {
      ...fresh,
      status: 'failed',
      total: emails.length,
      checked: known.size,
      cached: Math.max(0, known.size - newlyChecked),
      ...counts,
      errors,
      unchecked: Math.max(0, emails.length - known.size),
      billableChecks,
      estimatedCostUsd: estimateVerificationCostUsd(billableChecks, env.EMAIL_VERIFY_COST_PER_1000),
      finishedAt: Date.now(),
      error: message,
      lastError: safeError(err),
    });
    logger.error({ listId, runId, err: safeError(err) }, 'list email verification failed');
  }
}
