import { env } from '../config/env';
import { logger } from '../lib/logger';
import { inc } from '../lib/metrics';
import { fullSync, incrementalSync, isGoneError } from '../google/sync';
import type { GCalEvent } from '../google/types';
import { getConnection } from '../domain/connectionStore';
import type { StoredConnection } from '../domain/connection';
import { stateStore } from '../domain/stateStore';
import { acquireLock } from '../domain/lock';
import { computeChanges, buildChangeFingerprint, type AttendeeChange } from '../domain/dedupe';
import { toGhlAction } from '../domain/transform';
import { tryClaimDispatch, releaseDispatch } from '../domain/dispatchGuard';
import { matchingRules, type ConditionContext } from '../domain/condition';
import { saveSnapshot } from '../domain/snapshotStore';
import { mapping } from '../ghl/mapping';
import { updateAppointmentStatus } from '../ghl/appointments';
import { addTags, removeTags, setDnd, updateCustomField, addNote } from '../ghl/contacts';
import { dispatchGhlWebhook, buildWebhookPayload, postWebhook } from '../ghl/webhooks';

export async function processSync(connectionId: string): Promise<void> {
  const conn = await getConnection(connectionId);
  if (!conn) {
    logger.warn({ connectionId }, 'connection not found; skipping sync');
    return;
  }
  if (conn.status !== 'active') {
    logger.info({ connectionId, status: conn.status }, 'connection not active; skipping sync');
    return;
  }

  const locked = await acquireLock(connectionId, env.LOCK_TTL_SECONDS);
  if (!locked) {
    logger.info({ connectionId }, 'sync already in progress (lock held); skipping duplicate notification');
    return;
  }

  try {
    await runSync(conn);
  } finally {
    // The lock expires automatically via TTL.
  }
}

async function runSync(conn: StoredConnection): Promise<void> {
  const connectionId = conn.id;
  const syncToken = await stateStore.getSyncToken(connectionId);

  if (!syncToken) {
    logger.info({ connectionId }, 'no syncToken found; performing initial full sync');
    const { items, nextSyncToken } = await fullSync(conn);
    await stateStore.saveStates(connectionId, items.filter((e) => e.status !== 'cancelled'));
    await stateStore.saveSyncToken(connectionId, nextSyncToken);
    inc('sync_processed_total', { type: 'full' });
    logger.info({ connectionId, count: items.length }, 'full sync complete (baseline stored, nothing dispatched)');
    return;
  }

  let items: GCalEvent[];
  let nextSyncToken: string;
  try {
    ({ items, nextSyncToken } = await incrementalSync(conn, syncToken));
  } catch (err) {
    if (isGoneError(err)) {
      logger.warn({ connectionId }, 'syncToken expired (410); resetting state and re-syncing');
      await stateStore.clear(connectionId);
      await runSync(conn);
      return;
    }
    throw err;
  }

  const prevStates = await stateStore.getStates(connectionId);
  const changes = computeChanges(items, prevStates);

  for (const change of changes) {
    await dispatchChange(conn, change);
  }

  const cancelledIds = items.filter((e) => e.status === 'cancelled').map((e) => e.id);
  await stateStore.removeEvents(connectionId, cancelledIds);
  await stateStore.saveStates(connectionId, items.filter((e) => e.status !== 'cancelled'));
  await stateStore.saveSyncToken(connectionId, nextSyncToken);

  inc('sync_processed_total', { type: 'incremental' });
  logger.info({ connectionId, changed: changes.length, synced: items.length }, 'incremental sync complete');
}

async function dispatchChange(conn: StoredConnection, change: AttendeeChange): Promise<void> {
  const connectionId = conn.id;
  const action = toGhlAction(change.newStatus);
  const fingerprint = buildChangeFingerprint(connectionId, change);
  const mode = conn.ghlDeliveryMode ?? 'both';

  const claimed = await tryClaimDispatch(connectionId, fingerprint);
  if (!claimed) {
    inc('rsvp_duplicates_skipped_total');
    logger.info(
      { connectionId, eventId: change.eventId, email: change.email, status: change.newStatus },
      'duplicate dispatch detected; skipping'
    );
    return;
  }

  logger.info(
    { connectionId, eventId: change.eventId, email: change.email, from: change.previousStatus, to: change.newStatus, mode },
    'dispatching RSVP change'
  );

  try {
    let contact: { id: string } | null = null;
    let appointment: { id: string } | null = null;

    if (mode === 'api' || mode === 'both') {
      contact = await mapping.resolveContact(conn, change.email);
      appointment = await mapping.resolveAppointment(connectionId, change.eventId);

      if (appointment?.id) {
        await updateAppointmentStatus(conn, appointment.id, action.appointmentStatus, `${fingerprint}:status`);
      } else {
        logger.warn({ connectionId, eventId: change.eventId }, 'no GHL appointment mapping; skipping appointment status update');
      }

      if (contact?.id) {
        await addTags(conn, contact.id, action.tagsToAdd, `${fingerprint}:tags:add`);
        await removeTags(conn, contact.id, action.tagsToRemove, `${fingerprint}:tags:del`);
        if (action.setDnd) {
          await setDnd(conn, contact.id, true, `${fingerprint}:dnd`);
          await addNote(
            conn,
            contact.id,
            `[RSVP sync] ${change.email} declined${change.causedByCancellation ? ' (event cancelled)' : ''} event "${
              change.event.summary ?? change.eventId
            }". DND enabled.`,
            `${fingerprint}:note`
          );
        }
        if (env.GHL_RSVP_CUSTOM_FIELD_ID) {
          await updateCustomField(conn, contact.id, env.GHL_RSVP_CUSTOM_FIELD_ID, action.rsvp, `${fingerprint}:customfield`);
        }
      } else {
        logger.warn({ connectionId, email: change.email }, 'no GHL contact found for attendee');
      }
    }

    if (mode === 'webhook' || mode === 'both') {
      if (action.webhookBranch) {
        await dispatchGhlWebhook(conn, action.webhookBranch, buildWebhookPayload(change, { contact, appointment }, fingerprint));
      }
      await dispatchMatchingRules(conn, change, fingerprint, contact, appointment);
    }

    try {
      await saveSnapshot(connectionId, buildWebhookPayload(change, { contact, appointment }, fingerprint));
    } catch (err) {
      logger.warn({ connectionId, err: (err as Error).message }, 'failed to save payload snapshot');
    }

    inc('rsvp_dispatched_total', { status: action.rsvp });
  } catch (err) {
    inc('ghl_errors_total', { status: action.rsvp });
    await releaseDispatch(connectionId, fingerprint);
    throw err;
  }
}

async function dispatchMatchingRules(
  conn: StoredConnection,
  change: AttendeeChange,
  fingerprint: string,
  contact: { id: string } | null,
  appointment: { id: string } | null
): Promise<void> {
  if (!conn.rules || conn.rules.length === 0) return;

  const ctx: ConditionContext = {
    responseStatus: change.newStatus,
    email: change.email,
    eventSummary: change.event.summary ?? '',
    eventId: change.eventId,
    calendarId: conn.googleCalendarId,
  };

  const matched = matchingRules(conn.rules, ctx);
  for (const rule of matched) {
    try {
      const payload = buildWebhookPayload(change, { contact, appointment }, `${fingerprint}:rule:${rule.id}`);
      await postWebhook(rule.webhookUrl, payload);
      logger.info({ connectionId: conn.id, ruleId: rule.id, ruleName: rule.name }, 'automation rule webhook fired');
    } catch (err) {
      logger.error({ connectionId: conn.id, ruleId: rule.id, err: (err as Error).message }, 'automation rule webhook failed');
    }
  }
}

