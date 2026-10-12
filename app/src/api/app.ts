import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { webhookRoutes } from './routes/webhook';
import { healthRoutes } from './routes/health';
import { metricsRoutes } from './routes/metrics';
import { connectionRoutes } from './routes/connections';
import { oauthRoutes } from './routes/oauth';
import { infoRoutes } from './routes/info';
import { integrationRoutes } from './routes/integrations';
import { aiRoutes } from './routes/ai';
import { listRoutes } from './routes/lists';
import { knowledgeRoutes } from './routes/knowledge';
import { inviteRoutes } from './routes/invites';
import { sessionRoutes } from './routes/sessions';
import { videoRoutes } from './routes/video';
import { errorHandler } from './middleware/errorHandler';
import { registerAuth } from './middleware/requireAuth';
import { authRoutes } from './routes/auth';
import { teamRoutes } from './routes/team';

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.setErrorHandler(errorHandler);

  // Deny-by-default API auth (no-op unless AUTH_ENABLED=true).
  registerAuth(app);

  const publicDir = path.resolve(__dirname, '..', '..', 'public');
  void app.register(fastifyStatic, { root: publicDir, prefix: '/static/' });

  // Control panel (single page). `/invite` serves the same shell so invite
  // links resolve; the client reads ?token= and shows the accept-invite view.
  const serveSpa = async (_req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    reply.header('Content-Type', 'text/html; charset=utf-8').send(html);
  };
  app.get('/', serveSpa);
  app.get('/invite', serveSpa);

  void app.register(infoRoutes);
  void app.register(integrationRoutes);
  void app.register(aiRoutes);
  void app.register(listRoutes);
  void app.register(knowledgeRoutes);
  void app.register(inviteRoutes);
  void app.register(sessionRoutes);
  void app.register(videoRoutes);
  void app.register(authRoutes);
  void app.register(teamRoutes);
  void app.register(healthRoutes);
  void app.register(metricsRoutes);
  void app.register(webhookRoutes);
  void app.register(connectionRoutes);
  void app.register(oauthRoutes);

  return app;
}


