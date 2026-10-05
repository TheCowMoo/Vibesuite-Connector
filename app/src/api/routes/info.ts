import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';

export async function infoRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/info', async () => ({
    app: 'gcal-ghl-sync',
    version: '0.1.0',
    encryptionAtRest: Boolean(env.CREDENTIALS_ENCRYPTION_KEY),
  }));
}
