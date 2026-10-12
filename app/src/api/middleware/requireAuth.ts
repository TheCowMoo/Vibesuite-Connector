import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../../config/env';
import { isPublicPath } from '../../lib/authPaths';
import { readCookie } from '../../lib/cookies';
import { resolveSession } from '../../domain/auth';
import type { UserRecord, UserRole } from '../../domain/authStore';

export interface AuthedRequest extends FastifyRequest {
  user?: UserRecord;
}

export function getAuthUser(req: FastifyRequest): UserRecord | undefined {
  return (req as AuthedRequest).user;
}

/**
 * Deny-by-default. Only `/api/*` is locked down — the SPA shell (and static
 * assets) must stay reachable so the client can render the login view.
 * Allowlisted paths (webhook, OAuth callbacks, login endpoints) pass through.
 */
export function registerAuth(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!env.AUTH_ENABLED) return;

    const pathname = req.url.split('?')[0];
    if (isPublicPath(pathname)) return;

    const user = await resolveSession(readCookie(req, env.AUTH_COOKIE_NAME));
    if (user) {
      (req as AuthedRequest).user = user;
      return;
    }

    if (pathname.startsWith('/api/')) {
      reply.code(401).send({ error: 'not authenticated' });
      return reply;
    }
  });
}

export function requireRole(...roles: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Auth disabled → behave exactly as before (safe rollout).
    if (!env.AUTH_ENABLED) return;

    const user = getAuthUser(req);
    if (!user) {
      reply.code(401).send({ error: 'not authenticated' });
      return;
    }
    if (!roles.includes(user.role)) {
      reply.code(403).send({ error: 'insufficient role' });
    }
  };
}
