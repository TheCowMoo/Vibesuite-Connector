import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

vi.mock('../../src/domain/statsCollect', () => ({
  collectStatsOverview: vi.fn(async () => ({})),
}));

vi.mock('../../src/domain/statsExportCollect', () => {
  class StatsExportNotFoundError extends Error {}
  return { collectStatsExport: vi.fn(), StatsExportNotFoundError };
});

import { statsRoutes } from '../../src/api/routes/stats';
import { collectStatsExport, StatsExportNotFoundError } from '../../src/domain/statsExportCollect';

const collect = collectStatsExport as unknown as ReturnType<typeof vi.fn>;

async function build(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(statsRoutes);
  await app.ready();
  return app;
}

beforeEach(() => {
  collect.mockReset();
  collect.mockResolvedValue({
    columns: [{ key: 'value', label: 'Value' }],
    rows: [{ value: 7 }],
  });
});

describe('GET /api/stats/export', () => {
  it('returns a dated CSV attachment with a UTF-8 BOM', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/export?scope=calls&period=all',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="vibesuite-calls-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.body.startsWith('\uFEFF')).toBe(true);
    expect(res.body).toContain('Value\r\n7\r\n');
    await app.close();
  });

  it('passes the parsed scope, period and record filter to the collector', async () => {
    const app = await build();
    await app.inject({
      method: 'GET',
      url: '/api/stats/export?scope=campaigns&period=all&campaignId=camp_1',
    });
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'campaigns', days: null, campaignId: 'camp_1' }),
    );
    await app.close();
  });

  it('clamps all-time overview exports to the 365-day ceiling', async () => {
    const app = await build();
    await app.inject({ method: 'GET', url: '/api/stats/export?scope=summary&period=all' });
    expect(collect).toHaveBeenCalledWith(expect.objectContaining({ scope: 'summary', days: 365 }));
    await app.close();
  });

  it('returns JSON rows when asked', async () => {
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/export?scope=daily&format=json',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(JSON.parse(res.body)).toMatchObject({ scope: 'daily', rows: [{ value: 7 }] });
    await app.close();
  });

  it('rejects an unknown scope before collecting anything', async () => {
    const app = await build();
    const res = await app.inject({ method: 'GET', url: '/api/stats/export?scope=everything' });
    expect(res.statusCode).toBe(400);
    expect(collect).not.toHaveBeenCalled();
    await app.close();
  });

  it('turns a missing campaign or call into a 404', async () => {
    collect.mockRejectedValueOnce(new StatsExportNotFoundError('call not found'));
    const app = await build();
    const res = await app.inject({
      method: 'GET',
      url: '/api/stats/export?scope=calls&sessionId=sess_1',
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: 'call not found' });
    await app.close();
  });
});
