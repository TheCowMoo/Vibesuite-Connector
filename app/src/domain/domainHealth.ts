/**
 * Pure evaluation of the DNS records behind a sending domain.
 *
 * Nothing here touches the network, Redis or the clock: `domainHealthCheck.ts` does the lookups
 * and hands the records in. That split is deliberate — the rules are the part worth testing, and a
 * unit test should never depend on a live resolver (or on what the network thinks of a domain
 * today).
 *
 * Scope note: these are Google Calendar invitations, so Google sends the mail from its own
 * infrastructure. An IP blocklist would test Google, not the customer's domain. These checks cover
 * what the domain itself publishes: SPF, DKIM, DMARC, MX and the domain blocklists, plus MTA-STS
 * and BIMI for information. They do not claim inbox placement.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'unavailable';
export type CheckId = 'mx' | 'spf' | 'dkim' | 'dmarc' | 'dnsbl' | 'mta_sts' | 'bimi';
export type DomainStatus = 'healthy' | 'warning' | 'critical' | 'provider_managed' | 'unchecked';

export interface DomainCheck {
  id: CheckId;
  label: string;
  status: CheckStatus;
  summary: string;
  details: string[];
}

export interface DomainFinding {
  severity: 'critical' | 'warning' | 'info';
  check: CheckId;
  text: string;
  fix?: string;
}

function check(
  id: CheckId,
  label: string,
  status: CheckStatus,
  summary: string,
  details: string[] = [],
): DomainCheck {
  return { id, label, status, summary, details };
}

/* ---- SPF ------------------------------------------------------------------------------------ */

const SPF_START = /^v=spf1(?:\s|$)/i;

/** Every `v=spf1` TXT record on the domain. More than one is a broken SPF setup. */
export function spfRecords(txt: string[]): string[] {
  return txt.map((r) => String(r).trim()).filter((r) => SPF_START.test(r));
}

/** `-all`, `~all`, `?all`, `+all`, or undefined when the record has no `all` mechanism. */
export function spfAllMechanism(record: string): string | undefined {
  for (const raw of record.split(/\s+/)) {
    const token = raw.toLowerCase();
    if (/^[+\-~?]?all$/.test(token)) return token.startsWith('all') ? '+all' : token;
  }
  return undefined;
}

/**
 * Mechanisms that cost a DNS lookup, counted the way RFC 7208 does for the 10-lookup limit.
 * Nested includes are not expanded: this is the estimate a domain owner can act on.
 */
export function estimateSpfLookups(record: string): number {
  const counted = new Set(['include', 'a', 'mx', 'ptr', 'exists', 'redirect']);
  let lookups = 0;
  for (const raw of record.split(/\s+/).slice(1)) {
    const token = raw.replace(/^[+\-~?]/, '').toLowerCase();
    if (!token) continue;
    const name = token.split(/[:=]/)[0];
    if (counted.has(name)) lookups += 1;
  }
  return lookups;
}

export function evaluateSpf(records: string[]): DomainCheck {
  const recordsFound = spfRecords(records);
  if (recordsFound.length === 0) {
    return check('spf', 'SPF', 'fail', 'No SPF record found.', [
      'Without SPF, receivers cannot confirm that Google is allowed to send for this domain.',
    ]);
  }
  if (recordsFound.length > 1) {
    return check('spf', 'SPF', 'fail', `${recordsFound.length} SPF records found — only one is allowed.`, recordsFound);
  }

  const record = recordsFound[0];
  const lookups = estimateSpfLookups(record);
  const hasGoogle = /(?:^|\s)[+\-~?]?include:_spf\.google\.com(?:\s|$)/i.test(record);
  const all = spfAllMechanism(record);
  const details = [`Record: ${record}`, `DNS lookups: ${lookups} of 10`];

  if (!hasGoogle) {
    return check('spf', 'SPF', 'fail', 'SPF does not include Google (_spf.google.com).', details);
  }
  if (lookups > 10) {
    return check('spf', 'SPF', 'warn', `SPF needs about ${lookups} DNS lookups; receivers stop counting at 10.`, details);
  }
  if (lookups === 10) {
    details.push('Exactly at the lookup limit — one more mechanism would break SPF.');
  }
  if (all === '-all') {
    return check('spf', 'SPF', 'pass', 'SPF authorises Google and rejects everyone else.', details);
  }
  if (!all) {
    return check('spf', 'SPF', 'warn', 'SPF has no “all” mechanism, so unauthorised senders are not rejected.', details);
  }
  if (all === '+all') {
    return check('spf', 'SPF', 'warn', 'SPF ends in +all, which authorises every sender in the world.', details);
  }
  const wording = all === '?all' ? 'is neutral about unauthorised senders' : 'soft-fails unauthorised senders';
  return check('spf', 'SPF', 'warn', `SPF ${wording}; use -all once you know only Google sends for this domain.`, details);
}

/* ---- DMARC ---------------------------------------------------------------------------------- */

const DMARC_START = /^v=dmarc1(?:\s*;|\s*$)/i;

export function dmarcRecords(txt: string[]): string[] {
  return txt.map((r) => String(r).trim()).filter((r) => DMARC_START.test(r));
}

/** A DMARC/DKIM-style tag list (`a=b; c=d`). Keys are lowercased; the first value wins. */
export function parseTagList(record: string): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const part of String(record).split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const key = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1).trim();
    if (key && tags[key] === undefined) tags[key] = value;
  }
  return tags;
}

export function evaluateDmarc(records: string[]): DomainCheck {
  const recordsFound = dmarcRecords(records);
  if (recordsFound.length === 0) {
    return check('dmarc', 'DMARC', 'fail', 'No DMARC record found.', [
      'Without DMARC, receivers have no policy telling them what to do with spoofed mail from this domain.',
    ]);
  }
  if (recordsFound.length > 1) {
    return check('dmarc', 'DMARC', 'fail', `${recordsFound.length} DMARC records found — only one is allowed.`, recordsFound);
  }

  const record = recordsFound[0];
  const tags = parseTagList(record);
  const policy = (tags.p || '').toLowerCase();
  const pctRaw = tags.pct === undefined ? 100 : Number(tags.pct);
  const pct = Number.isFinite(pctRaw) ? Math.min(100, Math.max(0, Math.floor(pctRaw))) : 100;

  const details = [`Record: ${record}`, `Policy: ${policy || 'missing'}`, `Applied to: ${pct}% of mail`];
  if (tags.rua) details.push(`Reports go to: ${tags.rua}`);
  if (tags.ruf) details.push(`Forensic reports go to: ${tags.ruf}`);
  if (tags.sp) details.push(`Subdomain policy: ${tags.sp}`);

  if (!policy) {
    return check('dmarc', 'DMARC', 'fail', 'DMARC record has no policy (p=).', details);
  }
  if (policy !== 'none' && policy !== 'quarantine' && policy !== 'reject') {
    return check('dmarc', 'DMARC', 'fail', `DMARC policy “${policy}” is not valid.`, details);
  }
  if (policy === 'none') {
    return check('dmarc', 'DMARC', 'warn', 'DMARC only monitors (p=none); move to quarantine or reject.', details);
  }
  if (pct < 100) {
    return check('dmarc', 'DMARC', 'warn', `DMARC ${policy} applies to only ${pct}% of mail.`, details);
  }
  return check('dmarc', 'DMARC', 'pass', `DMARC ${policy} applies to all mail.`, details);
}

/* ---- DKIM ----------------------------------------------------------------------------------- */

export interface DkimProbe {
  selector: string;
  records: string[];
}

export const DEFAULT_DKIM_SELECTORS = [
  'google',
  'googlemail',
  'default',
  'selector1',
  'selector2',
  's1',
  'k1',
  'mail',
  'dkim',
] as const;

export function normalizeSelector(selector: string | undefined | null): string | undefined {
  const clean = String(selector ?? '').trim().toLowerCase();
  if (!clean || clean.length > 63) return undefined;
  return /^[a-z0-9._-]+$/.test(clean) ? clean : undefined;
}

/** The selectors to probe: the profile's own selector when set, otherwise the common set. */
export function dkimSelectors(selector?: string): string[] {
  const own = normalizeSelector(selector);
  return own ? [own] : [...DEFAULT_DKIM_SELECTORS];
}

export interface DkimRecordState {
  valid: boolean;
  revoked: boolean;
  reason: string;
}

/**
 * A DKIM key record is usable when `p=` is non-empty. An empty `p=` is how a revoked key is
 * published (RFC 6376 §3.6.1) — the selector still resolves, but it must not be trusted.
 */
export function parseDkim(record: string): DkimRecordState {
  const tags = parseTagList(record);
  const version = (tags.v || '').toUpperCase();
  const key = (tags.p || '').replace(/\s+/g, '');

  if (version && version !== 'DKIM1') {
    return { valid: false, revoked: false, reason: `unsupported version ${version}` };
  }
  if (key) return { valid: true, revoked: false, reason: 'public key published' };
  if (version === 'DKIM1' || tags.p !== undefined) {
    return { valid: false, revoked: true, reason: 'the public key is empty (revoked)' };
  }
  return { valid: false, revoked: false, reason: 'not a DKIM key record' };
}

/**
 * One check across every selector tried. A single usable key is enough — Workspace publishes
 * `google._domainkey`, but a domain may also sign with its own selector.
 */
export function evaluateDkimSelectors(probes: DkimProbe[]): DomainCheck {
  const usable: string[] = [];
  const revoked: string[] = [];
  const details = probes.map(
    (p) => `${p.selector}: ${p.records.length ? p.records.join(' | ') : 'no record'}`,
  );

  for (const probe of probes) {
    let state: 'valid' | 'revoked' | 'missing' = 'missing';
    for (const record of probe.records.map((r) => String(r).trim()).filter(Boolean)) {
      const parsed = parseDkim(record);
      if (parsed.valid) state = 'valid';
      else if (parsed.revoked && state !== 'valid') state = 'revoked';
    }
    if (state === 'valid') usable.push(probe.selector);
    else if (state === 'revoked') revoked.push(probe.selector);
  }

  if (usable.length > 0) {
    return check('dkim', 'DKIM', 'pass', `DKIM key found at ${usable.map((s) => `“${s}”`).join(', ')}.`, details);
  }
  if (revoked.length > 0) {
    return check(
      'dkim',
      'DKIM',
      'fail',
      `DKIM key at ${revoked.map((s) => `“${s}”`).join(', ')} is published but revoked (empty p=).`,
      details,
    );
  }
  const summary =
    probes.length === 1
      ? `No DKIM key found at “${probes[0].selector}”.`
      : `No DKIM key found (tried ${probes.length} common selectors).`;
  return check('dkim', 'DKIM', 'warn', summary, details);
}

export function evaluateDkim(selector: string, records: string[]): DomainCheck {
  return evaluateDkimSelectors([{ selector, records }]);
}

/* ---- MX ------------------------------------------------------------------------------------- */

export interface MxRecord {
  exchange: string;
  priority: number;
}

export function evaluateMx(records: MxRecord[]): DomainCheck {
  const rows = records.map((r) => ({
    priority: Number(r.priority) || 0,
    exchange: String(r.exchange ?? '').trim().toLowerCase(),
  }));

  if (rows.length === 0) {
    return check('mx', 'MX', 'warn', 'No MX records, so replies and bounces cannot be delivered.', [
      'Calendar invitations are outgoing, but recipients need a mailbox that accepts replies.',
    ]);
  }

  const nullMx = rows.filter((r) => r.exchange === '.' || r.exchange === '');
  if (nullMx.length > 0 && rows.length === 1) {
    return check('mx', 'MX', 'warn', 'This domain publishes a null MX, so it refuses all email.', [
      'A null MX ("0 .") tells every sender the domain accepts no mail. Remove it if you want replies.',
    ]);
  }
  if (nullMx.length > 0) {
    return check('mx', 'MX', 'warn', 'MX records mix a null MX with real mail servers.', [
      'RFC 7505 says a null MX must be the only MX record.',
    ]);
  }

  return check(
    'mx',
    'MX',
    'pass',
    `Mail is accepted by ${rows.length} server${rows.length === 1 ? '' : 's'}.`,
    rows.map((r) => `${r.priority} ${r.exchange}`),
  );
}

/* ---- Domain blocklists ---------------------------------------------------------------------- */

export const DNSBL_ZONES = [
  { host: 'dbl.spamhaus.org', label: 'Spamhaus DBL' },
  { host: 'multi.surbl.org', label: 'SURBL' },
] as const;

export type DnsblStatus = 'clean' | 'listed' | 'unavailable';

export interface DnsblProbe {
  zone: string;
  label: string;
  status: DnsblStatus;
  detail?: string;
}

/**
 * A blocklist answer is an A record in 127.0.0.0/8. `127.255.255.x` means Spamhaus refused the
 * query (usually a public resolver), and `127.0.0.1` is SURBL's equivalent — both are "we could not
 * ask", never "listed".
 */
export function interpretDnsbl(domain: string, probes: DnsblProbe[]): DomainCheck {
  const details = probes.map((p) => `${p.label}: ${p.status}${p.detail ? ` (${p.detail})` : ''}`);
  if (probes.length === 0) {
    return check('dnsbl', 'Blocklists', 'unavailable', 'Blocklists could not be checked.', details);
  }

  const listed = probes.filter((p) => p.status === 'listed');
  if (listed.length > 0) {
    return check(
      'dnsbl',
      'Blocklists',
      'fail',
      `Listed on ${listed.map((p) => p.label).join(' and ')}.`,
      details,
    );
  }

  const unavailable = probes.filter((p) => p.status === 'unavailable');
  if (unavailable.length > 0) {
    return check(
      'dnsbl',
      'Blocklists',
      'unavailable',
      `Could not check ${unavailable.map((p) => p.label).join(' or ')} — the resolver may block blocklist lookups.`,
      details,
    );
  }

  return check('dnsbl', 'Blocklists', 'pass', `${domain} is not listed on ${probes.map((p) => p.label).join(' or ')}.`, details);
}

/* ---- Informational extras ------------------------------------------------------------------- */

export function evaluateMtaSts(records: string[]): DomainCheck {
  const policy = records.map((r) => String(r).trim()).find((r) => /^v=STSv1(?:\s*;|\s*$)/i.test(r));
  return policy
    ? check('mta_sts', 'MTA-STS', 'info', 'MTA-STS policy published.', [`Record: ${policy}`])
    : check('mta_sts', 'MTA-STS', 'info', 'No MTA-STS policy published (optional).', []);
}

export function evaluateBimi(records: string[]): DomainCheck {
  const record = records.map((r) => String(r).trim()).find((r) => /^v=BIMI1(?:\s*;|\s*$)/i.test(r));
  return record
    ? check('bimi', 'BIMI', 'info', 'BIMI record published.', [`Record: ${record}`])
    : check('bimi', 'BIMI', 'info', 'No BIMI record published (optional).', []);
}

/* ---- Overall status ------------------------------------------------------------------------- */

/** A failure here is critical: mail from this domain is either unauthorised or blocklisted. */
const CRITICAL_WHEN_FAILED = new Set<CheckId>(['spf', 'dmarc', 'dnsbl']);

export const CHECK_FIXES: Partial<Record<CheckId, string>> = {
  mx: 'Add an MX record (Google Workspace normally uses smtp.google.com) so replies and bounces can arrive, and remove any null MX.',
  spf: 'Publish one SPF TXT record that includes _spf.google.com and ends with -all.',
  dkim: 'Turn on DKIM in the Google Workspace admin console and publish the key at the selector shown in Sending accounts.',
  dmarc: 'Publish _dmarc TXT with v=DMARC1; p=quarantine; rua=mailto:dmarc@yourdomain.com, then move to p=reject once reports look clean.',
  dnsbl: 'Request removal from the blocklist and fix the underlying authentication or spam problem before sending again.',
};

export function overallStatus(checks: DomainCheck[], providerManaged = false): DomainStatus {
  if (providerManaged) return 'provider_managed';
  if (checks.some((c) => c.status === 'fail' && CRITICAL_WHEN_FAILED.has(c.id))) return 'critical';
  if (checks.some((c) => c.status === 'fail' || c.status === 'warn' || c.status === 'unavailable')) return 'warning';
  return 'healthy';
}

/**
 * Findings are what the operator can act on. Provider-managed domains keep the findings (the
 * information is still useful) but they are downgraded to informational and never carry a fix —
 * nobody can change gmail.com's DNS.
 */
export function findingsFor(checks: DomainCheck[], providerManaged = false): DomainFinding[] {
  const findings: DomainFinding[] = [];
  for (const c of checks) {
    if (c.status === 'pass' || c.status === 'info') continue;
    const critical = c.status === 'fail' && CRITICAL_WHEN_FAILED.has(c.id);
    findings.push({
      severity: providerManaged ? 'info' : critical ? 'critical' : 'warning',
      check: c.id,
      text: c.summary,
      // "Unavailable" means the lookup itself failed: we do not know what the record says, so
      // suggesting a DNS change would be guesswork.
      fix: providerManaged || c.status === 'unavailable' ? undefined : CHECK_FIXES[c.id],
    });
  }
  return findings;
}

export interface DomainReportCore {
  domain: string;
  status: DomainStatus;
  providerManaged: boolean;
  checks: DomainCheck[];
  findings: DomainFinding[];
}

export function buildDomainReport(input: {
  domain: string;
  checks: DomainCheck[];
  providerManaged?: boolean;
}): DomainReportCore {
  const providerManaged = input.providerManaged === true;
  return {
    domain: input.domain,
    status: overallStatus(input.checks, providerManaged),
    providerManaged,
    checks: input.checks,
    findings: findingsFor(input.checks, providerManaged),
  };
}

/* ---- Where the sending domain comes from ---------------------------------------------------- */

/** Consumer mailboxes are run by the provider; their DNS is not the operator's to fix. */
export const CONSUMER_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'ymail.com',
  'rocketmail.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com',
  '126.com',
]);

/** Lowercase, strip a trailing root dot, and reject anything that is not a hostname. */
export function normalizeDomain(value: string | undefined | null): string | undefined {
  const clean = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!clean || clean.length > 253) return undefined;
  return isValidDomain(clean) ? clean : undefined;
}

export function isValidDomain(value: string): boolean {
  const clean = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!clean || clean.length > 253) return false;
  const labels = clean.split('.');
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return false;
  }
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld);
}

export function domainFromEmail(value: string | undefined | null): string | undefined {
  const email = String(value ?? '').trim();
  if (!email) return undefined;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return undefined;
  return normalizeDomain(email.slice(at + 1));
}

export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(String(domain).trim().toLowerCase());
}

/**
 * `primary` resolves to the authenticated user, and a `*.calendar.google.com` id names a shared or
 * resource calendar — neither carries the sender's mail domain in the string itself.
 */
export function isProviderCalendarId(calendarId: string | undefined | null): boolean {
  const id = String(calendarId ?? '').trim().toLowerCase();
  return id === 'primary' || id.endsWith('.calendar.google.com');
}

export type SenderDomainSource = 'profile' | 'subject' | 'calendar' | 'calendar_lookup';

export interface SenderIdentity {
  connectionId: string;
  name: string;
  calendarId: string;
  /** `googleSubject` — the Workspace user, when the connection was built with a service account. */
  subjectEmail?: string;
  /** Per-account override from Sending accounts. */
  sendingDomain?: string;
  /** Per-account selector override from Sending accounts. */
  dkimSelector?: string;
  /** Filled in by the caller from `calendars.get()` (cached for a day). */
  resolvedCalendarEmail?: string;
  /** Why the calendar lookup failed, if it did. */
  resolveError?: string;
}

export interface SenderDomainAccount {
  connectionId: string;
  name: string;
  source: SenderDomainSource;
  dkimSelector?: string;
}

export interface SenderDomainGroup {
  domain: string;
  providerManaged: boolean;
  accounts: SenderDomainAccount[];
  /** Selectors explicitly chosen by the accounts on this domain. */
  selectors: string[];
}

export interface UnresolvedSender {
  connectionId: string;
  name: string;
  reason: string;
}

export interface DomainSourceReport {
  domains: SenderDomainGroup[];
  unresolved: UnresolvedSender[];
}

/** True when the string alone cannot reveal the domain and a Calendar lookup is worth a call. */
export function needsCalendarLookup(identity: SenderIdentity): boolean {
  if (normalizeDomain(identity.sendingDomain)) return false;
  if (domainFromEmail(identity.subjectEmail)) return false;
  if (isProviderCalendarId(identity.calendarId)) return true;
  return !domainFromEmail(identity.calendarId);
}

function unresolvedReason(identity: SenderIdentity): string {
  if (identity.resolveError) {
    return `Google could not confirm this calendar's address (${identity.resolveError}).`;
  }
  const id = String(identity.calendarId ?? '').trim().toLowerCase();
  if (id === 'primary') {
    return 'This calendar is “primary”, so Google does not reveal the account’s email address.';
  }
  if (id.endsWith('.calendar.google.com')) {
    return 'This is a shared or resource calendar, so its ID does not contain the sender’s domain.';
  }
  return 'This calendar ID is not an email address, so its domain cannot be inferred.';
}

/**
 * The override always wins, then the service-account subject, then the calendar ID itself, and
 * finally the address the Calendar API returned for `primary`.
 */
export function resolveSenderDomain(identity: SenderIdentity): {
  domain?: string;
  source?: SenderDomainSource;
  reason?: string;
} {
  const override = normalizeDomain(identity.sendingDomain);
  if (override) return { domain: override, source: 'profile' };

  const subject = domainFromEmail(identity.subjectEmail);
  if (subject) return { domain: subject, source: 'subject' };

  if (!isProviderCalendarId(identity.calendarId)) {
    const calendar = domainFromEmail(identity.calendarId);
    if (calendar) return { domain: calendar, source: 'calendar' };
  }

  const looked = domainFromEmail(identity.resolvedCalendarEmail);
  if (looked && !looked.endsWith('.calendar.google.com')) {
    return { domain: looked, source: 'calendar_lookup' };
  }

  return { reason: unresolvedReason(identity) };
}

/** Group accounts by domain, deduped, with consumers marked provider-managed. */
export function collectSendingDomainGroups(identities: SenderIdentity[]): DomainSourceReport {
  const byDomain = new Map<string, SenderDomainGroup>();
  const unresolved: UnresolvedSender[] = [];

  for (const identity of identities) {
    const resolved = resolveSenderDomain(identity);
    if (!resolved.domain) {
      unresolved.push({
        connectionId: identity.connectionId,
        name: identity.name,
        reason: resolved.reason ?? 'The sending domain could not be determined.',
      });
      continue;
    }

    let group = byDomain.get(resolved.domain);
    if (!group) {
      group = {
        domain: resolved.domain,
        providerManaged: isConsumerDomain(resolved.domain),
        accounts: [],
        selectors: [],
      };
      byDomain.set(resolved.domain, group);
    }
    group.accounts.push({
      connectionId: identity.connectionId,
      name: identity.name,
      source: resolved.source ?? 'calendar',
      dkimSelector: normalizeSelector(identity.dkimSelector),
    });
  }

  const domains = [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  for (const group of domains) {
    group.accounts.sort((a, b) => a.name.localeCompare(b.name));
    group.selectors = [...new Set(group.accounts.map((a) => a.dkimSelector).filter((s): s is string => !!s))];
  }
  unresolved.sort((a, b) => a.name.localeCompare(b.name));

  return { domains, unresolved };
}

