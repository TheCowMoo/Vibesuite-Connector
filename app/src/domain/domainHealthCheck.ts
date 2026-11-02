/**
 * Live half of the domain reputation checker.
 *
 * `domainHealth.ts` decides what the records mean; this file fetches them with Node's built-in
 * resolver and caches the verdict in Redis. No new dependency, no external reputation API.
 *
 * The report is a snapshot of DNS, not a promise about inbox placement: Google sends these
 * invitations from shared infrastructure, so IP reputation and Postmaster data are deliberately
 * out of scope.
 */
import { Resolver } from 'node:dns/promises';
import { env } from '../config/env';
import { REDIS_KEYS } from '../config/constants';
import { redis } from '../queue/connection';
import { logger } from '../lib/logger';
import { createCalendarClient } from '../google/auth';
import { listConnections } from './connectionStore';
import { getSenderProfile } from './senderStore';
import { forEachLimit } from './concurrency';
import {
  DNSBL_ZONES,
  buildDomainReport,
  collectSendingDomainGroups,
  dkimSelectors,
  dmarcRecords,
  domainFromEmail,
  evaluateBimi,
  evaluateDkimSelectors,
  evaluateDmarc,
  evaluateMtaSts,
  evaluateMx,
  evaluateSpf,
  interpretDnsbl,
  isConsumerDomain,
  isProviderCalendarId,
  needsCalendarLookup,
  normalizeDomain,
  normalizeSelector,
  spfRecords,
  type DkimProbe,
  type DnsblProbe,
  type DomainCheck,
  type DomainFinding,
  type DomainStatus,
  type MxRecord,
  type SenderDomainAccount,
  type SenderDomainGroup,
  type SenderIdentity,
  type UnresolvedSender,
} from './domainHealth';
import type { StoredConnection } from './connection';

const DNS_TIMEOUT_MS = 5000;
const DNS_TRIES = 2;
const DNSBL_LOCK_SECONDS = 90;
const CALENDAR_CACHE_SECONDS = 60 * 60 * 24;
const REFRESH_CONCURRENCY = 3;

export interface DomainRawRecords {
  spf: string[];
  dmarc: string[];
  dkim: Array<{ selector: string; records: string[] }>;
  mx: string[];
  mtaSts: string[];
  bimi: string[];
}

/** Everything `checkDomain()` learns about one domain, before accounts are attached. */
export interface DomainCoreReport {
  domain: string;
  status: DomainStatus;
  providerManaged: boolean;
  checks: DomainCheck[];
  findings: DomainFinding[];
  raw: DomainRawRecords;
  checkedAt: number;
}

/** The shape `/api/deliverability` returns for one domain. */
export interface DomainReportView {
  domain: string;
  status: DomainStatus;
  providerManaged: boolean;
  accounts: SenderDomainAccount[];
  selectors: string[];
  checks: DomainCheck[];
  findings: DomainFinding[];
  raw: DomainRawRecords | null;
  checkedAt: number | null;
}

export interface DeliverabilitySummary {
  total: number;
  healthy: number;
  warning: number;
  critical: number;
  unchecked: number;
  providerManaged: number;
}

export interface DeliverabilityResponse {
  domains: DomainReportView[];
  unresolved: UnresolvedSender[];
  summary: DeliverabilitySummary;
}

export interface SendingDomainCollection {
  domains: SenderDomainGroup[];
  unresolved: UnresolvedSender[];
}

interface Lookup<T> {
  ok: boolean;
  value: T;
  error?: string;
}

function errorCode(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** NXDOMAIN and "no data" both mean the record is absent, not that the resolver failed. */
function isMissing(err: unknown): boolean {
  return ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(errorCode(err));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' })), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function createResolver(): Resolver {
  return new Resolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES });
}

async function lookupTxt(resolver: Resolver, host: string): Promise<Lookup<string[]>> {
  try {
    const rows = await withTimeout(resolver.resolveTxt(host), DNS_TIMEOUT_MS * DNS_TRIES);
    return { ok: true, value: rows.map((chunks) => chunks.join('')) };
  } catch (err) {
    if (isMissing(err)) return { ok: true, value: [] };
    return { ok: false, value: [], error: errorMessage(err) };
  }
}

async function lookupMx(resolver: Resolver, host: string): Promise<Lookup<MxRecord[]>> {
  try {
    const rows = await withTimeout(resolver.resolveMx(host), DNS_TIMEOUT_MS * DNS_TRIES);
    return { ok: true, value: rows.map((r) => ({ exchange: r.exchange, priority: r.priority })) };
  } catch (err) {
    if (isMissing(err)) return { ok: true, value: [] };
    return { ok: false, value: [], error: errorMessage(err) };
  }
}

async function lookupAddresses(resolver: Resolver, host: string): Promise<Lookup<string[]>> {
  try {
    const rows = await withTimeout(resolver.resolve4(host), DNS_TIMEOUT_MS * DNS_TRIES);
    return { ok: true, value: rows };
  } catch (err) {
    if (isMissing(err)) return { ok: true, value: [] };
    return { ok: false, value: [], error: errorMessage(err) };
  }
}

/**
 * Spamhaus and SURBL publish an A record in 127.0.0.0/8 when a domain is listed. Their "you are
 * using a blocked resolver" codes (127.255.255.x / 127.0.0.1) must be reported as unavailable,
 * never as a listing.
 */
function classifyDnsbl(zone: string, label: string, result: Lookup<string[]>): DnsblProbe {
  if (!result.ok) {
    return { zone, label, status: 'unavailable', detail: result.error || 'lookup failed' };
  }
  if (result.value.length === 0) return { zone, label, status: 'clean' };

  const blocked = result.value.some((ip) => ip.startsWith('127.255.255.') || ip === '127.0.0.1');
  if (blocked) {
    return { zone, label, status: 'unavailable', detail: 'resolver is blocked by the blocklist' };
  }
  if (result.value.some((ip) => ip.startsWith('127.'))) {
    return { zone, label, status: 'listed', detail: result.value.join(', ') };
  }
  return { zone, label, status: 'unavailable', detail: `unexpected answer ${result.value.join(', ')}` };
}

async function probeDnsbl(resolver: Resolver, domain: string, zone: string, label: string): Promise<DnsblProbe> {
  const result = await lookupAddresses(resolver, `${domain}.${zone}`);
  return classifyDnsbl(zone, label, result);
}

function unavailableCheck(id: DomainCheck['id'], label: string, message: string): DomainCheck {
  return {
    id,
    label,
    status: 'unavailable',
    summary: `${label} could not be checked: ${message}.`,
    details: [],
  };
}

function infoUnavailable(label: 'MTA-STS' | 'BIMI', id: 'mta_sts' | 'bimi', message: string): DomainCheck {
  return { id, label, status: 'info', summary: `${label} could not be checked.`, details: [message] };
}

/** The selectors an account explicitly chose, or the common Google/Workspace set. */
export function selectorsForGroup(group: SenderDomainGroup): string[] {
  const own = [...new Set(group.selectors.map((s) => normalizeSelector(s)).filter((s): s is string => !!s))];
  return own.length > 0 ? own : dkimSelectors();
}

/**
 * Query every record for one domain and turn the answers into a report. DNS failures are captured
 * per check (`unavailable`) rather than thrown, so one broken lookup cannot blank the whole page.
 */
export async function checkDomain(domain: string, selectors: string[] = []): Promise<DomainCoreReport> {
  const host = normalizeDomain(domain);
  if (!host) throw new Error(`invalid domain: ${domain}`);

  const chosen = [...new Set(selectors.map((s) => normalizeSelector(s)).filter((s): s is string => !!s))];
  const probes = chosen.length > 0 ? chosen : dkimSelectors();

  const resolver = createResolver();
  const [domainTxt, dmarcTxt, mtaTxt, bimiTxt, mxRows, dnsblProbes, dkimResults] = await Promise.all([
    lookupTxt(resolver, host),
    lookupTxt(resolver, `_dmarc.${host}`),
    lookupTxt(resolver, `_mta-sts.${host}`),
    lookupTxt(resolver, `default._bimi.${host}`),
    lookupMx(resolver, host),
    Promise.all(DNSBL_ZONES.map((zone) => probeDnsbl(resolver, host, zone.host, zone.label))),
    Promise.all(probes.map((selector) => lookupTxt(resolver, `${selector}._domainkey.${host}`))),
  ]);

  const dkimProbes: DkimProbe[] = probes.map((selector, i) => ({
    selector,
    records: dkimResults[i].ok ? dkimResults[i].value : [],
  }));
  const dkimFailures = dkimResults.filter((r) => !r.ok);
  const allDkimLookupsFailed = dkimResults.length > 0 && dkimFailures.length === dkimResults.length;

  const checks: DomainCheck[] = [
    mxRows.ok ? evaluateMx(mxRows.value) : unavailableCheck('mx', 'MX', mxRows.error ?? 'lookup failed'),
    domainTxt.ok ? evaluateSpf(domainTxt.value) : unavailableCheck('spf', 'SPF', domainTxt.error ?? 'lookup failed'),
    allDkimLookupsFailed
      ? unavailableCheck('dkim', 'DKIM', dkimFailures[0].error ?? 'lookup failed')
      : evaluateDkimSelectors(dkimProbes),
    dmarcTxt.ok ? evaluateDmarc(dmarcTxt.value) : unavailableCheck('dmarc', 'DMARC', dmarcTxt.error ?? 'lookup failed'),
    interpretDnsbl(host, dnsblProbes),
    mtaTxt.ok ? evaluateMtaSts(mtaTxt.value) : infoUnavailable('MTA-STS', 'mta_sts', mtaTxt.error ?? 'lookup failed'),
    bimiTxt.ok ? evaluateBimi(bimiTxt.value) : infoUnavailable('BIMI', 'bimi', bimiTxt.error ?? 'lookup failed'),
  ];

  const core = buildDomainReport({ domain: host, checks, providerManaged: isConsumerDomain(host) });
  const raw: DomainRawRecords = {
    spf: domainTxt.ok ? spfRecords(domainTxt.value) : [],
    dmarc: dmarcTxt.ok ? dmarcRecords(dmarcTxt.value) : [],
    dkim: dkimProbes,
    mx: mxRows.ok ? mxRows.value.map((m) => `${m.priority} ${m.exchange}`) : [],
    mtaSts: mtaTxt.ok ? mtaTxt.value : [],
    bimi: bimiTxt.ok ? bimiTxt.value : [],
  };

  return { ...core, raw, checkedAt: Date.now() };
}

/* ---- Calendar lookup for `primary` and resource calendars ----------------------------------- */

export interface CalendarResolution {
  email?: string;
  error?: string;
}

/**
 * `calendars.get()` is the only way to turn `primary` into a real address. The answer is cached for
 * a day per connection; a failed lookup is not cached, so a transient Google error can recover.
 */
export async function resolveCalendarEmail(conn: StoredConnection): Promise<CalendarResolution> {
  const key = REDIS_KEYS.calendarEmail(conn.id);
  try {
    const cached = await redis.get(key);
    if (cached) return cached === '-' ? {} : { email: cached };
  } catch {
    // A cache miss caused by Redis should not stop the lookup.
  }

  try {
    const calendar = createCalendarClient(conn);
    const res = await calendar.calendars.get({ calendarId: conn.googleCalendarId });
    const id = String(res.data.id ?? '').trim();
    if (!id || isProviderCalendarId(id) || !domainFromEmail(id)) {
      await redis.set(key, '-', 'EX', CALENDAR_CACHE_SECONDS).catch(() => undefined);
      return { error: 'the calendar did not return an email address' };
    }
    await redis.set(key, id, 'EX', CALENDAR_CACHE_SECONDS).catch(() => undefined);
    return { email: id };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

/**
 * The accounts behind the checker: every Google connection plus its sender profile. Accounts whose
 * calendar hides the address get one cached Calendar API call; the rest are resolved from strings.
 */
export async function collectSendingDomains(): Promise<SendingDomainCollection> {
  const conns = await listConnections();
  const profiles = await Promise.all(conns.map((c) => getSenderProfile(c.id)));

  const identities: SenderIdentity[] = conns.map((conn, i) => ({
    connectionId: conn.id,
    name: conn.name,
    calendarId: conn.googleCalendarId,
    subjectEmail: conn.googleSubject,
    sendingDomain: profiles[i]?.sendingDomain,
    dkimSelector: profiles[i]?.dkimSelector,
  }));

  const lookups = identities.filter(needsCalendarLookup);
  await forEachLimit(lookups, 2, async (identity) => {
    const conn = conns.find((c) => c.id === identity.connectionId);
    if (!conn) return;
    const resolved = await resolveCalendarEmail(conn);
    if (resolved.email) identity.resolvedCalendarEmail = resolved.email;
    else identity.resolveError = resolved.error ?? 'Google returned no usable address';
  });

  return collectSendingDomainGroups(identities);
}

/* ---- Cache ---------------------------------------------------------------------------------- */

export async function saveDomainReport(report: DomainCoreReport): Promise<void> {
  const ttlSeconds = Math.max(60, env.DOMAIN_HEALTH_CACHE_MINUTES * 60);
  await redis
    .multi()
    .sadd(REDIS_KEYS.domainHealthIndex(), report.domain)
    .set(REDIS_KEYS.domainHealth(report.domain), JSON.stringify(report), 'EX', ttlSeconds)
    .exec();
}

async function readDomainReport(domain: string): Promise<DomainCoreReport | null> {
  const raw = await redis.get(REDIS_KEYS.domainHealth(domain));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DomainCoreReport;
  } catch {
    return null;
  }
}

/** Keep `domain:health:index` to the domains that still belong to a sending account. */
async function pruneDomainIndex(liveDomains: string[]): Promise<void> {
  try {
    const indexed = await redis.smembers(REDIS_KEYS.domainHealthIndex());
    const stale = indexed.filter((domain) => !liveDomains.includes(domain));
    if (stale.length > 0) await redis.srem(REDIS_KEYS.domainHealthIndex(), ...stale);
  } catch {
    // Best effort only: a missing index never blocks the report.
  }
}

export function summarizeDomains(domains: DomainReportView[]): DeliverabilitySummary {
  const count = (status: DomainStatus): number => domains.filter((d) => d.status === status).length;
  return {
    total: domains.length,
    healthy: count('healthy'),
    warning: count('warning'),
    critical: count('critical'),
    unchecked: count('unchecked'),
    providerManaged: count('provider_managed'),
  };
}

/** Cache-only read: opening the page never fires a DNS burst. */
export async function getCachedReports(): Promise<DeliverabilityResponse> {
  const { domains, unresolved } = await collectSendingDomains();
  return buildResponse(domains, unresolved);
}

async function buildResponse(
  groups: SenderDomainGroup[],
  unresolved: UnresolvedSender[],
): Promise<DeliverabilityResponse> {
  await pruneDomainIndex(groups.map((g) => g.domain));

  const domains = await Promise.all(
    groups.map(async (group): Promise<DomainReportView> => {
      const cached = await readDomainReport(group.domain);
      const providerManaged = group.providerManaged || isConsumerDomain(group.domain);
      return {
        domain: group.domain,
        status: providerManaged ? 'provider_managed' : cached?.status ?? 'unchecked',
        providerManaged,
        accounts: group.accounts,
        selectors: selectorsForGroup(group),
        checks: cached?.checks ?? [],
        findings: cached?.findings ?? [],
        raw: cached?.raw ?? null,
        checkedAt: cached?.checkedAt ?? null,
      };
    }),
  );

  return { domains, unresolved, summary: summarizeDomains(domains) };
}

/**
 * Force fresh DNS for every sending domain (or just the named ones), then return the cached view.
 * The per-domain lock keeps two operators from firing the same burst twice; a locked domain simply
 * keeps whatever is already cached.
 */
export async function refreshDomains(domains?: string[]): Promise<DeliverabilityResponse> {
  const collection = await collectSendingDomains();
  const groups = collection.domains;

  const requested = [...new Set((domains ?? []).map((d) => normalizeDomain(d)).filter((d): d is string => !!d))];
  let targets = groups;
  if (requested.length > 0) {
    const known = new Set(groups.map((g) => g.domain));
    const unknown = requested.filter((d) => !known.has(d));
    if (unknown.length > 0) throw new Error(`not a sending domain: ${unknown.join(', ')}`);
    targets = groups.filter((g) => requested.includes(g.domain));
  }

  await forEachLimit(targets, REFRESH_CONCURRENCY, async (group) => {
    const lockKey = REDIS_KEYS.domainHealthLock(group.domain);

    let locked = false;
    try {
      locked = (await redis.set(lockKey, '1', 'EX', DNSBL_LOCK_SECONDS, 'NX')) === 'OK';
    } catch {
      locked = true; // Never let a Redis hiccup turn the checker off.
    }
    if (!locked) return;

    try {
      const report = await checkDomain(group.domain, selectorsForGroup(group));
      await saveDomainReport(report);
    } catch (err) {
      logger.warn({ domain: group.domain, err: errorMessage(err) }, 'domain health check failed');
    } finally {
      await redis.del(lockKey).catch(() => undefined);
    }
  });

  return buildResponse(collection.domains, collection.unresolved);
}