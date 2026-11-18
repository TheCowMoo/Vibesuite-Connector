import type { FastifyInstance } from 'fastify';
import {
  getConnection,
  listConnections,
  saveConnection,
  deleteConnection,
  newConnectionId,
  publicConnection,
} from '../../domain/connectionStore';
import type {
  StoredConnection,
  WebhookUrls,
  DeliveryMode,
  AutomationRule,
  AttendanceTags,
  AttendanceRosterSettings,
  AttendanceAiWorkflowSettings,
  AttendanceWorkflowRule,
  WorkflowTarget,
} from '../../domain/connection';
import { parseWorkflowSettings } from '../../domain/workflowSettings';
import { normalizeRosterShape } from '../../domain/attendanceRoster';
import { bootstrapConnection } from '../../domain/bootstrap';
import { getSnapshot } from '../../domain/snapshotStore';
import { describeGhlVerificationError, verifyEmailWithGhl } from '../../ghl/emailVerification';
import { env } from '../../config/env';

interface CreateConnectionBody {
  name?: string;
  googleCalendarId: string;
  ghlLocationId?: string;
  ghlAuthType?: 'api_token' | 'oauth';
  ghlApiToken?: string;
  webhookUrls?: WebhookUrls;
  ghlDeliveryMode?: DeliveryMode;
  rules?: AutomationRule[];
}

interface UpdateConnectionBody {
  name?: string;
  googleCalendarId?: string;
  ghlLocationId?: string;
  ghlAuthType?: 'api_token' | 'oauth';
  ghlApiToken?: string;
  webhookUrls?: WebhookUrls;
  ghlDeliveryMode?: DeliveryMode;
  rules?: AutomationRule[];
  attendanceDeliveryMode?: DeliveryMode;
  attendanceRules?: AutomationRule[];
  attendanceTags?: AttendanceTags;
  attendanceCustomFieldId?: string;
  attendanceWorkflows?: WorkflowTarget[];
  attendanceWorkflowRules?: AttendanceWorkflowRule[];
  attendanceAiWorkflow?: AttendanceAiWorkflowSettings;
  attendanceRoster?: AttendanceRosterSettings & { token?: string };
  clearAttendanceRosterToken?: boolean;
}

export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/connections', async () => {
    const conns = await listConnections();
    return { connections: conns.map(publicConnection) };
  });

  app.get('/api/connections/:id', async (req, reply) => {
    const conn = await getConnection((req.params as { id: string }).id);
    if (!conn) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    return { connection: publicConnection(conn) };
  });

  app.get('/api/connections/:id/snapshot', async (req, reply) => {
    const snapshot = await getSnapshot((req.params as { id: string }).id);
    return { snapshot };
  });

  app.post('/api/connections', async (req, reply) => {
    const body = req.body as CreateConnectionBody;
    if (!body.googleCalendarId) {
      reply.code(400).send({ error: 'googleCalendarId is required' });
      return;
    }

    const id = newConnectionId();
    const now = Date.now();
    const conn: StoredConnection = {
      id,
      name: body.name ?? body.googleCalendarId,
      status: 'pending_google',
      googleCalendarId: body.googleCalendarId,
      googleAuthType: 'oauth',
      ghlAuthType: body.ghlAuthType ?? 'api_token',
      ghlLocationId: body.ghlLocationId ?? '',
      ghlApiToken: body.ghlApiToken,
      webhookUrls: body.webhookUrls,
      ghlDeliveryMode: body.ghlDeliveryMode ?? 'both',
      rules: body.rules ?? [],
      createdAt: now,
      updatedAt: now,
    };
    await saveConnection(conn);
    reply.code(201).send({ connection: publicConnection(conn) });
  });

  app.patch('/api/connections/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const conn = await getConnection(id);
    if (!conn) {
      reply.code(404).send({ error: 'not found' });
      return;
    }

    const body = req.body as UpdateConnectionBody;

    if (body.name !== undefined) conn.name = body.name;
    if (body.googleCalendarId !== undefined) conn.googleCalendarId = body.googleCalendarId;
    if (body.ghlLocationId !== undefined) conn.ghlLocationId = body.ghlLocationId;
    if (body.ghlAuthType !== undefined) conn.ghlAuthType = body.ghlAuthType;
    if (body.ghlApiToken) conn.ghlApiToken = body.ghlApiToken; // blank keeps existing
    if (body.ghlDeliveryMode !== undefined) conn.ghlDeliveryMode = body.ghlDeliveryMode;
    if (body.rules !== undefined) conn.rules = body.rules;
    if (body.attendanceDeliveryMode !== undefined) conn.attendanceDeliveryMode = body.attendanceDeliveryMode;
    if (body.attendanceRules !== undefined) conn.attendanceRules = body.attendanceRules;
    if (body.attendanceTags !== undefined) {
      const clean = (value?: string) => (value && value.trim() ? value.trim() : undefined);
      conn.attendanceTags = {
        attended: clean(body.attendanceTags.attended),
        partial: clean(body.attendanceTags.partial),
        noShow: clean(body.attendanceTags.noShow),
        notInvited: clean(body.attendanceTags.notInvited),
      };
    }
    if (body.attendanceCustomFieldId !== undefined) {
      conn.attendanceCustomFieldId = body.attendanceCustomFieldId.trim() || undefined;
    }
    if (body.attendanceRoster !== undefined) {
      const url = body.attendanceRoster.url?.trim();
      // Keep the format this connection already uses when the PATCH only touches the URL or token;
      // new configurations default to the flat call report.
      conn.attendanceRoster = url
        ? {
            url,
            shape: normalizeRosterShape(body.attendanceRoster.shape, conn.attendanceRoster?.shape ?? 'flat'),
          }
        : undefined;
      // A blank token keeps the stored one; "remove" is explicit so an accidental save cannot break
      // a working webhook. The token itself is encrypted with the other connection secrets.
      if (body.clearAttendanceRosterToken) conn.attendanceRosterToken = undefined;
      const token = body.attendanceRoster.token?.trim();
      if (token) conn.attendanceRosterToken = token;
    }
    if (body.webhookUrls !== undefined) {
      conn.webhookUrls = {
        yes: body.webhookUrls.yes || undefined,
        maybe: body.webhookUrls.maybe || undefined,
        no: body.webhookUrls.no || undefined,
      };
    }

    // Workflow settings are validated as a whole: rules may only reference a workflow that is in
    // the same list. Existing values fill in whichever fields this PATCH did not send.
    const touchesWorkflows =
      body.attendanceWorkflows !== undefined ||
      body.attendanceWorkflowRules !== undefined ||
      body.attendanceAiWorkflow !== undefined;
    if (touchesWorkflows) {
      const parsed = parseWorkflowSettings({
        attendanceWorkflows: body.attendanceWorkflows ?? conn.attendanceWorkflows ?? [],
        attendanceWorkflowRules: body.attendanceWorkflowRules ?? conn.attendanceWorkflowRules ?? [],
        attendanceAiWorkflow: body.attendanceAiWorkflow ?? conn.attendanceAiWorkflow,
      });
      if (!parsed.ok) {
        reply.code(400).send({ error: parsed.error, details: parsed.details });
        return;
      }
      conn.attendanceWorkflows = parsed.value.attendanceWorkflows;
      conn.attendanceWorkflowRules = parsed.value.attendanceWorkflowRules;
      conn.attendanceAiWorkflow = parsed.value.attendanceAiWorkflow;
    }

    conn.updatedAt = Date.now();
    await saveConnection(conn);
    return { connection: publicConnection(conn) };
  });

  app.post('/api/connections/:id/bootstrap', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const conn = await getConnection(id);
    if (!conn) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    try {
      await bootstrapConnection(id);
      return { ok: true };
    } catch (err) {
      reply.code(500).send({ error: (err as Error).message });
    }
  });

  /**
   * One-address readiness probe for GHL Email Verification.
   *
   * This is intentionally explicit: it proves the location's LC Email/Mailgun setup, the token's
   * `lc-email.readonly` scope and the wallet charge before any list-wide run can spend money.
   */
  app.post('/api/connections/:id/email-verification/test', async (req, reply) => {
    const conn = await getConnection((req.params as { id: string }).id);
    if (!conn) {
      reply.code(404).send({ error: 'not found' });
      return;
    }
    if (!conn.ghlLocationId) {
      reply.code(400).send({ error: 'GHL location id is missing on this connection' });
      return;
    }

    const b = (req.body || {}) as { email?: string };
    const email = typeof b.email === 'string' ? b.email.trim() : '';
    if (!email) {
      reply.code(400).send({ error: 'email is required' });
      return;
    }

    try {
      const verification = await verifyEmailWithGhl(conn, email);
      return {
        ok: true,
        verification,
        estimatedCostUsd: env.EMAIL_VERIFY_COST_PER_1000 / 1000,
      };
    } catch (err) {
      reply.code(502).send({
        error: describeGhlVerificationError(err),
        detail: (err as Error)?.message || 'unknown error',
      });
    }
  });

  app.delete('/api/connections/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await deleteConnection(id);
    return { ok: true };
  });
}
