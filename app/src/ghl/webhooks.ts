import axios from 'axios';
import { logger } from '../lib/logger';
import type { StoredConnection } from '../domain/connection';
import type { GhlWebhookBranch } from '../domain/transform';
import type { AttendeeChange } from '../domain/dedupe';

export async function dispatchGhlWebhook(
  conn: StoredConnection,
  branch: Exclude<GhlWebhookBranch, null>,
  payload: Record<string, unknown>
): Promise<void> {
  const url =
    branch === 'confirmed' ? conn.webhookUrls?.yes : branch === 'tentative' ? conn.webhookUrls?.maybe : conn.webhookUrls?.no;
  if (!url) {
    logger.warn({ branch, connectionId: conn.id }, 'No webhook URL configured for branch; skipping');
    return;
  }
  await axios.post(url, payload, { timeout: 15000 });
}

export async function postWebhook(url: string, payload: Record<string, unknown>): Promise<void> {
  await axios.post(url, payload, { timeout: 15000 });
}

export function buildWebhookPayload(
  change: AttendeeChange,
  context: { contact?: { id: string } | null; appointment?: { id: string } | null },
  idempotencyKey?: string
): Record<string, unknown> {
  return {
    eventId: change.eventId,
    email: change.email,
    responseStatus: change.newStatus,
    previousStatus: change.previousStatus ?? null,
    causedByCancellation: change.causedByCancellation,
    eventSummary: change.event.summary ?? null,
    eventStart: change.event.start?.dateTime ?? change.event.start?.date ?? null,
    contactId: context.contact?.id ?? null,
    appointmentId: context.appointment?.id ?? null,
    idempotencyKey: idempotencyKey ?? null,
    timestamp: new Date().toISOString(),
  };
}

