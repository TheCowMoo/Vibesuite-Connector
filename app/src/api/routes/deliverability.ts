import type { FastifyInstance } from 'fastify';
import { getCachedReports, refreshDomains } from '../../domain/domainHealthCheck';
import { normalizeDomain } from '../../domain/domainHealth';
import { requireRole } from '../middleware/requireAuth';

/**
 * Domain reputation / deliverability.
 *
 * `GET` only reads the cache, so opening the view never fires DNS. `POST /refresh` is the explicit
 * "check now": it bypasses the cache and re-queries every domain (or the one named), with a
 * per-domain lock so two operators cannot start the same burst.
 */
export async function deliverabilityRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: requireRole('owner', 'admin') };

  app.get('/api/deliverability', guard, async () => getCachedReports());

  app.post('/api/deliverability/refresh', guard, async (req, reply) => {
    const body = (req.body || {}) as { domain?: unknown };
    const raw = typeof body.domain === 'string' ? body.domain.trim() : '';
    const domain = raw ? normalizeDomain(raw) : undefined;

    if (raw && !domain) {
      reply.code(400).send({ error: 'invalid domain' });
      return;
    }

    try {
      const data = await refreshDomains(domain ? [domain] : undefined);
      return { ok: true, ...data };
    } catch (err) {
      reply.code(400).send({ error: (err as Error).message });
      return;
    }
  });
}