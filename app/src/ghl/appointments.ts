import { ghlRequest } from './client';
import type { StoredConnection } from '../domain/connection';

export interface GhlAppointment {
  id: string;
  calendarId?: string;
  locationId?: string;
  contactId?: string;
  startTime?: string;
  endTime?: string;
  title?: string;
  appointmentStatus?: string;
  [key: string]: unknown;
}

export async function getAppointment(conn: StoredConnection, appointmentId: string): Promise<GhlAppointment> {
  return ghlRequest<GhlAppointment>(conn, { method: 'GET', url: `/calendars/events/${appointmentId}` });
}

export async function updateAppointmentStatus(conn: StoredConnection, appointmentId: string, status: string, idempotencyKey?: string): Promise<GhlAppointment> {
  // NOTE: verify the exact field name ("appointmentStatus") against the GHL v2 reference
  // before production use; the v2 events/appointments API may use a different key.
  return ghlRequest<GhlAppointment>(
    conn,
    { method: 'PUT', url: `/calendars/events/${appointmentId}`, data: { appointmentStatus: status } },
    { idempotencyKey }
  );
}

