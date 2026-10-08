import type { FastifyInstance } from 'fastify';
import { getIntegrationCatalog } from '../../domain/integrations';

export async function integrationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/integrations', async () => {
    return { integrations: getIntegrationCatalog() };
  });
}
