import { ghlRequest } from './client';
import type { StoredConnection } from '../domain/connection';

export interface GhlContact {
  id: string;
  email?: string;
  dnd?: boolean;
  customFields?: Array<{ id: string; value: string }>;
  [key: string]: unknown;
}

export async function lookupContactByEmail(conn: StoredConnection, email: string): Promise<GhlContact | null> {
  const params: Record<string, string> = { email };
  if (conn.ghlLocationId) params.locationId = conn.ghlLocationId;

  const res = await ghlRequest<{ contacts?: GhlContact[] } | GhlContact[]>(conn, {
    method: 'GET',
    url: '/contacts/lookup',
    params,
  });

  const contacts: GhlContact[] = Array.isArray(res) ? res : (res?.contacts ?? []);
  return contacts[0] ?? null;
}

export async function addTags(conn: StoredConnection, contactId: string, tags: string[], idempotencyKey?: string): Promise<void> {
  if (tags.length === 0) return;
  await ghlRequest(conn, { method: 'POST', url: `/contacts/${contactId}/tags`, data: { tags } }, { idempotencyKey });
}

export async function removeTags(conn: StoredConnection, contactId: string, tags: string[], idempotencyKey?: string): Promise<void> {
  for (const tag of tags) {
    await ghlRequest(
      conn,
      { method: 'DELETE', url: `/contacts/${contactId}/tags/${encodeURIComponent(tag)}` },
      { idempotencyKey: idempotencyKey ? `${idempotencyKey}:${tag}` : undefined }
    );
  }
}

export async function setDnd(conn: StoredConnection, contactId: string, dnd: boolean, idempotencyKey?: string): Promise<void> {
  await ghlRequest(conn, { method: 'PUT', url: `/contacts/${contactId}`, data: { dnd } }, { idempotencyKey });
}

export async function updateCustomField(conn: StoredConnection, contactId: string, fieldId: string, value: string, idempotencyKey?: string): Promise<void> {
  await ghlRequest(
    conn,
    { method: 'PUT', url: `/contacts/${contactId}`, data: { customFields: [{ id: fieldId, value }] } },
    { idempotencyKey }
  );
}

export async function addNote(conn: StoredConnection, contactId: string, body: string, idempotencyKey?: string): Promise<void> {
  // NOTE: verify the v2 note endpoint/body shape against the GHL reference before production use.
  await ghlRequest(conn, { method: 'POST', url: `/contacts/${contactId}/notes`, data: { body } }, { idempotencyKey });
}

