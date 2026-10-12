import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env';
import { clearCookie, readCookie, setCookie } from '../../lib/cookies';
import { publicUser } from '../../domain/authStore';
import {
  acceptInvite,
  changePassword,
  createOwner,
  endSession,
  issueLogin,
  loginWithPassword,
  needsSetup,
  resolveSession,
} from '../../domain/auth';
import { getAuthUser } from '../middleware/requireAuth';

function cookieSecure(): boolean {
  return (env.OAUTH_BASE_URL || '').startsWith('https://');
}

function sessionCookieOpts(): { maxAgeSeconds: number; secure: boolean } {
  return { maxAgeSeconds: env.SESSION_TTL_DAYS * 86400, secure: cookieSecure() };
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/auth/me', async (req) => {
    const user = await resolveSession(readCookie(req, env.AUTH_COOKIE_NAME));
    return {
      enabled: env.AUTH_ENABLED,
      authenticated: !!user,
      user: user ? publicUser(user) : null,
      needsSetup: await needsSetup(),
    };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const b = req.body as { email?: string; password?: string };
    if (!b.email || !b.password) {
      reply.code(400).send({ error: 'email and password are required' });
      return;
    }
    const out = await loginWithPassword(b.email, b.password, req.ip);
    if (!out.ok) {
      reply.code(out.status).send({ error: out.error });
      return;
    }
    setCookie(reply, env.AUTH_COOKIE_NAME, out.token, sessionCookieOpts());
    return { ok: true, user: publicUser(out.user) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    await endSession(readCookie(req, env.AUTH_COOKIE_NAME));
    clearCookie(reply, env.AUTH_COOKIE_NAME, { secure: cookieSecure() });
    return { ok: true };
  });

  app.post('/api/auth/setup', async (req, reply) => {
    const b = req.body as { email?: string; name?: string; password?: string };
    if (!b.email || !b.password) {
      reply.code(400).send({ error: 'email and password are required' });
      return;
    }
    if (String(b.password).length < 8) {
      reply.code(400).send({ error: 'password must be at least 8 characters' });
      return;
    }
    if (!(await needsSetup())) {
      reply.code(400).send({ error: 'setup is not available' });
      return;
    }
    const user = await createOwner({ email: b.email, name: b.name || b.email, password: b.password });
    const { token } = await issueLogin(user.id);
    setCookie(reply, env.AUTH_COOKIE_NAME, token, sessionCookieOpts());
    return { ok: true, user: publicUser(user) };
  });

  app.post('/api/auth/accept-invite', async (req, reply) => {
    const b = req.body as { token?: string; name?: string; password?: string };
    if (!b.token || !b.password) {
      reply.code(400).send({ error: 'token and password are required' });
      return;
    }
    if (String(b.password).length < 8) {
      reply.code(400).send({ error: 'password must be at least 8 characters' });
      return;
    }
    try {
      const user = await acceptInvite(b.token, b.name || '', b.password);
      const { token } = await issueLogin(user.id);
      setCookie(reply, env.AUTH_COOKIE_NAME, token, sessionCookieOpts());
      return { ok: true, user: publicUser(user) };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.post('/api/auth/change-password', async (req, reply) => {
    const user = getAuthUser(req);
    if (!user) {
      reply.code(401).send({ error: 'not authenticated' });
      return;
    }
    const b = req.body as { currentPassword?: string; newPassword?: string };
    if (!b.currentPassword || !b.newPassword) {
      reply.code(400).send({ error: 'currentPassword and newPassword are required' });
      return;
    }
    if (String(b.newPassword).length < 8) {
      reply.code(400).send({ error: 'password must be at least 8 characters' });
      return;
    }
    try {
      await changePassword(user.id, b.currentPassword, b.newPassword);
      clearCookie(reply, env.AUTH_COOKIE_NAME, { secure: cookieSecure() });
      return { ok: true, reauth: true };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
    }
  });
}
