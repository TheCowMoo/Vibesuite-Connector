import type { FastifyInstance } from 'fastify';
import {
  getConnection,
  listConnections,
  saveConnection,
  deleteConnection,
  newConnectionId,
  publicConnection,
} from '../../domain/connectionStore';
import type { StoredConnection, WebhookUrls } from '../../domain/connection';
import { bootstrapConnection } from '../../domain/bootstrap';

interface CreateConnectionBody {
  name?: string;
  googleCalendarId: string;
  ghlLocationId?: string;
  ghlAuthType?: 'api_token' | 'oauth';
  ghlApiToken?: string;
  webhookUrls?: WebhookUrls;
}

interface UpdateConnectionBody {
  name?: string;
  googleCalendarId?: string;
  ghlLocationId?: string;
  ghlAuthType?: 'api_token' | 'oauth';
  ghlApiToken?: string;
  webhookUrls?: WebhookUrls;
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
    if (body.webhookUrls !== undefined) {
      conn.webhookUrls = {
        yes: body.webhookUrls.yes || undefined,
        maybe: body.webhookUrls.maybe || undefined,
        no: body.webhookUrls.no || undefined,
      };
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

  app.delete('/api/connections/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    await deleteConnection(id);
    return { ok: true };
  });
}
