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
  requestPasswordReset,
  resetPassword,
  resolveSession,
} from '../../domain/auth';
import { getAuthUser } from '../middleware/requireAuth';
import { passwordProblem } from '../../domain/passwordPolicy';
import { sha256 } from '../../lib/tokens';
import {
  bumpPasswordResetAttempts,
  getPasswordResetAttempts,
} from '../../domain/authStore';
import { logger } from '../../lib/logger';

const PASSWORD_RESET_MAX_REQUESTS = 5;
const PASSWORD_RESET_ATTEMPT_WINDOW_SECONDS = 15 * 60;

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
    const problem = passwordProblem(b.password, { email: b.email, name: b.name });
    if (problem) {
      reply.code(400).send({ error: problem });
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
    const problem = passwordProblem(b.password);
    if (problem) {
      reply.code(400).send({ error: problem });
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

  app.post('/api/auth/forgot-password', async (req, reply) => {
    if (!env.AUTH_ENABLED) {
      return { ok: true };
    }
    const b = (req.body || {}) as { email?: string };
    const email = String(b.email || '').trim().toLowerCase();
    if (!email) {
      reply.code(400).send({ error: 'email is required' });
      return;
    }

    const attemptKey = `forgot:${email}:${req.ip ?? 'unknown'}`;
    if ((await getPasswordResetAttempts(attemptKey)) >= PASSWORD_RESET_MAX_REQUESTS) {
      reply.code(429).send({ error: 'too many reset requests — try again later' });
      return;
    }
    await bumpPasswordResetAttempts(attemptKey, PASSWORD_RESET_ATTEMPT_WINDOW_SECONDS);

    try {
      const result = await requestPasswordReset(email, env.OAUTH_BASE_URL, req.ip);
      if (result.requested && result.delivery && !result.delivery.ok) {
        logger.warn({ email, delivery: result.delivery }, 'password reset email could not be delivered');
      }
    } catch (err) {
      // Never reveal whether the account exists or whether delivery succeeded.
      logger.warn({ email, err: (err as Error).message }, 'password reset request failed');
    }
    return { ok: true };
  });

  app.post('/api/auth/reset-password', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = (req.body || {}) as { token?: string; newPassword?: string };
    if (typeof b.token !== 'string' || !b.token || typeof b.newPassword !== 'string' || !b.newPassword) {
      reply.code(400).send({ error: 'token and newPassword are required' });
      return;
    }
    const problem = passwordProblem(b.newPassword);
    if (problem) {
      reply.code(400).send({ error: problem });
      return;
    }

    // Rate-limit per token, not per IP: behind nginx every request shares the proxy address, which
    // would lock out the whole team after a handful of legitimate resets.
    const attemptKey = `reset:${sha256(b.token)}`;
    if ((await getPasswordResetAttempts(attemptKey)) >= PASSWORD_RESET_MAX_REQUESTS * 2) {
      reply.code(429).send({ error: 'too many reset attempts — try again later' });
      return;
    }
    await bumpPasswordResetAttempts(attemptKey, PASSWORD_RESET_ATTEMPT_WINDOW_SECONDS);

    try {
      await resetPassword(b.token, b.newPassword);
      clearCookie(reply, env.AUTH_COOKIE_NAME, { secure: cookieSecure() });
      return { ok: true, reauth: true };
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
    const problem = passwordProblem(b.newPassword, { email: user.email, name: user.name });
    if (problem) {
      reply.code(400).send({ error: problem });
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
