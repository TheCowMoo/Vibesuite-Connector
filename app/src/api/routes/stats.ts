import type { FastifyInstance } from 'fastify';
import { collectStatsOverview } from '../../domain/statsCollect';
import { collectStatsExport, StatsExportNotFoundError } from '../../domain/statsExportCollect';
import {
  exportFilename,
  isOverviewScope,
  normalizeExportFormat,
  normalizeExportPeriod,
  normalizeExportScope,
  toCsv,
  toJsonRows,
} from '../../domain/statsExport';

/**
 * Aggregate numbers for the Statistics view, plus downloadable tables built from the same data.
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

  /**
   * One table per download. CSV is the default; `format=json` returns the same rows keyed by column.
   * Overview scopes are inherently windowed, so `period=all` means the 365-day ceiling for them.
   */
  app.get('/api/stats/export', async (req, reply) => {
    const q = req.query as {
      scope?: string;
      period?: string;
      format?: string;
      campaignId?: string;
      sessionId?: string;
    };

    const scope = normalizeExportScope(q.scope);
    if (!scope) {
      reply.code(400).send({ error: 'unknown export scope' });
      return;
    }

    const format = normalizeExportFormat(q.format);
    let days = normalizeExportPeriod(q.period);
    if (days === null && isOverviewScope(scope)) days = 365;

    const campaignId = q.campaignId?.trim() || undefined;
    const sessionId = q.sessionId?.trim() || undefined;

    try {
      const table = await collectStatsExport({ scope, days, campaignId, sessionId });
      const filename = exportFilename(scope, format, Date.now(), campaignId ?? sessionId);

      reply
        .header(
          'Content-Type',
          format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        )
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .header('Cache-Control', 'no-store');

      if (format === 'json') {
        return { scope, generatedAt: new Date().toISOString(), rows: toJsonRows(table) };
      }
      return toCsv(table);
    } catch (err) {
      if (err instanceof StatsExportNotFoundError) {
        reply.code(404).send({ error: err.message });
        return;
      }
      throw err;
    }
  });
}
