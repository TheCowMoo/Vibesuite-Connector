import { createHash } from 'node:crypto';
import axios from 'axios';
import { env } from '../config/env';
import { REDIS_KEYS } from '../config/constants';
import { logger } from '../lib/logger';
import { redis } from '../queue/connection';
import type { CopyObjective } from './copyEvidence';

export interface CopyWebSource {
  id: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface CopyWebResearch {
  enabled: boolean;
  available: boolean;
  sources: CopyWebSource[];
  error?: string;
}

const EMPTY: CopyWebResearch = { enabled: false, available: false, sources: [] };

export function buildCopyResearchQueries(objective: CopyObjective): string[] {
  const queries = [
    'Google Calendar invitation email subject line best practices',
    'webinar invitation email copy acceptance rate best practices',
  ];
  if (objective === 'show_up') {
    queries.push('reduce webinar no-shows invitation copy and reminder best practices');
  } else if (objective === 'replies') {
    queries.push('B2B webinar invitation copy that gets qualified replies');
  } else {
    queries.push('webinar invite copy qualified registrations and attendance best practices');
  }
  return queries.slice(0, 3);
}

function safeUrl(value: unknown): string {
  const url = String(value ?? '').trim();
  return /^https?:\/\/\S+$/i.test(url) ? url.slice(0, 1000) : '';
}

/** Parse and dedupe provider results into citable sources. */
export function normalizeTavilyResults(
  raw: unknown,
  max: number,
  prefix = 'web',
): CopyWebSource[] {
  const rows = Array.isArray((raw as { results?: unknown })?.results)
    ? ((raw as { results: Array<Record<string, unknown>> }).results)
    : [];
  const seen = new Set<string>();
  const out: CopyWebSource[] = [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const title = String(row.title ?? '').trim().slice(0, 200);
    const url = safeUrl(row.url);
    const snippet = String(row.content ?? row.snippet ?? '').trim().slice(0, 500);
    if (!title || !url) continue;
    const key = url.toLowerCase().replace(/\/+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const publishedAt = String(row.published_date ?? row.publishedAt ?? '').trim().slice(0, 40);
    out.push({
      id: `${prefix}${out.length + 1}`,
      title,
      url,
      snippet,
      ...(publishedAt ? { publishedAt } : {}),
    });
    if (out.length >= Math.max(1, Math.min(10, max))) break;
  }
  return out;
}

export function formatWebResearch(research: CopyWebResearch | null | undefined): string {
  if (!research || !research.sources.length) return '';
  return research.sources
    .map((source) => `[${source.id}] ${source.title} — ${source.url}${source.snippet ? ` — ${source.snippet}` : ''}`)
    .join('\n');
}

async function searchTavily(query: string): Promise<unknown> {
  const res = await axios.post(
    'https://api.tavily.com/search',
    {
      api_key: env.COPY_RESEARCH_API_KEY,
      query,
      search_depth: 'basic',
      max_results: env.COPY_RESEARCH_MAX_SOURCES,
      include_answer: false,
      include_raw_content: false,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
  );
  return res.data;
}

function cacheKey(objective: CopyObjective): string {
  return createHash('sha256')
    .update(`${env.COPY_RESEARCH_PROVIDER}|${objective}|${env.COPY_RESEARCH_MAX_SOURCES}|${buildCopyResearchQueries(objective).join('|')}`)
    .digest('hex')
    .slice(0, 24);
}

function parseCached(raw: string | null): CopyWebResearch | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as CopyWebResearch;
    if (!value || !Array.isArray(value.sources)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Optional live research for Copy Coach.
 *
 * Off by default. Queries contain only generic topic/objective words — never recipient data, list names
 * or the operator's copy. Failures are non-fatal: current-campaign and historical evidence still work.
 */
export async function researchCopyBestPractices(objective: CopyObjective): Promise<CopyWebResearch> {
  if (!env.COPY_RESEARCH_ENABLED) {
    return { ...EMPTY, error: 'Web research is disabled. Set COPY_RESEARCH_ENABLED=true to use it.' };
  }
  if (!env.COPY_RESEARCH_API_KEY) {
    return { enabled: true, available: false, sources: [], error: 'COPY_RESEARCH_API_KEY is not set.' };
  }

  try {
    const key = REDIS_KEYS.copyWebResearch(cacheKey(objective));
    const cached = parseCached(await redis.get(key));
    if (cached && cached.available) return cached;

    const settled = await Promise.allSettled(
      buildCopyResearchQueries(objective).map((query) => searchTavily(query)),
    );
    for (const result of settled) {
      if (result.status === 'rejected') {
        logger.warn({ err: result.reason }, 'one copy research query failed; continuing with the rest');
      }
    }
    const combined = settled.flatMap((result) =>
      result.status === 'fulfilled'
        ? ((result.value as { results?: unknown[] })?.results ?? [])
        : [],
    );
    const sources = normalizeTavilyResults({ results: combined }, env.COPY_RESEARCH_MAX_SOURCES);
    const result: CopyWebResearch = { enabled: true, available: sources.length > 0, sources };
    await redis.set(key, JSON.stringify(result), 'EX', env.COPY_RESEARCH_CACHE_HOURS * 60 * 60);
    return result;
  } catch (err) {
    logger.warn({ err }, 'copy web research failed');
    return {
      enabled: true,
      available: false,
      sources: [],
      error: 'Web research is temporarily unavailable.',
    };
  }
}
