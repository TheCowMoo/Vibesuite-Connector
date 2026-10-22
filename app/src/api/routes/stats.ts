import type { FastifyInstance } from 'fastify';
import { collectStatsOverview } from '../../domain/statsCollect';

/**
 * Aggregate numbers for the Statistics view.
 *
 * The period is clamped rather than trusted: `days=99999` would render a decade of empty bars, and a
 * missing value should mean the default window, not an empty one.
 */
export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats/overview', async (req) => {
    const q = req.query as { days?: string };
    const parsed = Number(q.days ?? 30);
    const days = Number.isFinite(parsed) ? Math.min(365, Math.max(1, Math.floor(parsed))) : 30;
    return collectStatsOverview(days);
  });
}
