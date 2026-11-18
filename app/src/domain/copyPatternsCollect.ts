import { env } from '../config/env';
import { REDIS_KEYS } from '../config/constants';
import { logger } from '../lib/logger';
import { redis } from '../queue/connection';
import { campaignVariants } from './campaignVariants';
import { listCampaigns } from './campaignStore';
import { collectCampaignStats } from './campaignStatsCollect';
import { aggregateCopyPatterns, type CopyPatternRow, type CopyPatterns } from './copyPatterns';

const CACHE_TTL_SECONDS = env.COPY_PATTERNS_CACHE_MINUTES * 60;

function parseCache(raw: string | null): CopyPatterns | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as CopyPatterns;
    if (!value || !Array.isArray(value.patterns) || typeof value.generatedAt !== 'number') return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Load historical feature patterns across started campaigns.
 *
 * The result is cached because it requires stats reads for every campaign. It is supplementary
 * evidence: failures are logged and the caller can continue with current-campaign evidence only.
 */
export async function collectCopyPatterns(now = Date.now()): Promise<CopyPatterns> {
  const cached = parseCache(await redis.get(REDIS_KEYS.copyPatterns()));
  if (cached && now - cached.generatedAt < CACHE_TTL_SECONDS * 1000) return cached;

  const campaigns = (await listCampaigns()).filter((camp) => camp.startedAt);
  const rows: CopyPatternRow[] = [];

  for (const camp of campaigns.slice(0, 100)) {
    try {
      const stats = await collectCampaignStats(camp);
      if (!stats.variants.length) continue;
      const copies = new Map(campaignVariants(camp).map((variant) => [variant.id, variant]));
      for (const variant of stats.variants) {
        const copy = copies.get(variant.variant);
        if (!copy) continue;
        rows.push({
          campaignId: camp.id,
          variant: variant.variant,
          summary: copy.summary,
          description: copy.description,
          sent: variant.sent,
          accepted: variant.accepted,
          tentative: variant.tentative,
          attended: variant.attended,
          hasAttendance: stats.hasAttendance,
        });
      }
    } catch (err) {
      logger.warn({ err, campaignId: camp.id }, 'could not include campaign in copy pattern analysis');
    }
  }

  const patterns = aggregateCopyPatterns(rows, now);
  await redis.set(REDIS_KEYS.copyPatterns(), JSON.stringify(patterns), 'EX', CACHE_TTL_SECONDS);
  return patterns;
}
