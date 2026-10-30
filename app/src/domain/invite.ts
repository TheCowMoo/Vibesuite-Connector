export interface InviteSegment {
  name: string;
  rows?: unknown[];
}

export interface SegmentationResult {
  segments?: InviteSegment[];
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isLikelyEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function collectFromValue(value: unknown, out: Set<string>): void {
  if (value == null) return;
  if (typeof value === 'string') {
    const matches = value.match(EMAIL_RE);
    if (matches) for (const m of matches) out.add(normalizeEmail(m));
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectFromValue(v, out);
    return;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const emailKey = keys.find((k) => /e-?mail/i.test(k));
    if (emailKey !== undefined) collectFromValue(obj[emailKey], out);
    for (const k of keys) {
      if (k === emailKey) continue;
      collectFromValue(obj[k], out);
    }
  }
}

function collectFromRows(rows: unknown[]): string[] {
  const out = new Set<string>();
  for (const row of rows) collectFromValue(row, out);
  return Array.from(out);
}

export interface RecipientPlan {
  emails: string[];
  perSegment: Array<{ name: string; emails: string[] }>;
  invalid: string[];
  duplicatesRemoved: number;
}

/**
 * Pull recipient emails out of a segmentation result. Rows may be arbitrary
 * objects or plain strings; emails are found via a dedicated email-ish key or a
 * regex scan over every value. Results are lowercased and de-duplicated.
 */
export function extractRecipients(result: SegmentationResult | unknown, segmentNames?: string[]): RecipientPlan {
  const segments = Array.isArray((result as SegmentationResult)?.segments)
    ? ((result as SegmentationResult).segments as InviteSegment[])
    : [];
  const selected = segmentNames && segmentNames.length ? segments.filter((s) => segmentNames.includes(s.name)) : segments;

  const globalSeen = new Set<string>();
  const perSegment: RecipientPlan['perSegment'] = [];
  const invalidSet = new Set<string>();
  let duplicatesRemoved = 0;

  for (const seg of selected) {
    const raw = collectFromRows(Array.isArray(seg.rows) ? (seg.rows as unknown[]) : []);
    const emails: string[] = [];
    const segSeen = new Set<string>();

    for (const e of raw) {
      if (!isLikelyEmail(e)) {
        invalidSet.add(e);
        continue;
      }
      if (segSeen.has(e)) {
        duplicatesRemoved += 1;
        continue;
      }
      segSeen.add(e);
      emails.push(e);
    }

    const finalEmails: string[] = [];
    for (const e of emails) {
      if (globalSeen.has(e)) {
        duplicatesRemoved += 1;
        continue;
      }
      globalSeen.add(e);
      finalEmails.push(e);
    }
    perSegment.push({ name: seg.name, emails: finalEmails });
  }

  return {
    emails: Array.from(globalSeen),
    perSegment,
    invalid: Array.from(invalidSet),
    duplicatesRemoved,
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** "2026-10-08T13:18" (from a datetime-local input) → "2026-10-08T13:18:00" (RFC 3339). */
export function toRfc3339(value: string): string {
  const v = value.trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v) ? `${v}:00` : v;
}

export function hasTimeZoneOffset(value: string): boolean {
  return /([Zz]|[+-]\d{2}:?\d{2})$/.test(value.trim());
}

/**
 * Epoch millis for an event's wall-clock start, honouring the event's IANA timezone.
 *
 * `Date.parse('2026-10-08T13:18')` interprets a naive value in the *server's* timezone, which is
 * usually UTC in a container. An event at 13:18 Asia/Manila is 05:18 UTC; treating it as 13:18 UTC
 * would let a batch run eight hours after the event began. Values that already carry `Z` or an
 * offset are parsed directly.
 */
export function eventStartEpoch(value: string, timeZone?: string): number | null {
  const trimmed = value.trim();
  if (hasTimeZoneOffset(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?/.exec(trimmed);
  if (!m) {
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] ?? 0);
  const millis = Number((m[7] ?? '').padEnd(3, '0') || 0);
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millis);

  if (!timeZone || !timeZone.trim()) return wallAsUtc;

  try {
    // What wall time does `instant` show in `timeZone`? The difference from the same fields read as
    // UTC is the zone's offset at that moment. Two passes settle it across a DST transition.
    const offsetAt = (instant: number): number => {
      const base = Math.floor(instant / 1000) * 1000;
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timeZone.trim(),
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(new Date(base));
      const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
      const shownAsUtc = Date.UTC(
        get('year'),
        get('month') - 1,
        get('day'),
        get('hour') % 24,
        get('minute'),
        get('second'),
      );
      return shownAsUtc - base;
    };

    let epoch = wallAsUtc - offsetAt(wallAsUtc);
    epoch = wallAsUtc - offsetAt(epoch);
    return Number.isFinite(epoch) ? epoch : null;
  } catch {
    // An unrecognised zone is left to Google to reject; keep the guard deterministic meanwhile.
    return wallAsUtc;
  }
}

export function resolveEventTime(value: string, timeZone?: string): { dateTime: string; timeZone?: string } {
  const dateTime = toRfc3339(value);
  if (hasTimeZoneOffset(dateTime)) {
    return { dateTime };
  }
  if (!timeZone || !timeZone.trim()) {
    throw new Error('timeZone is required when start/end have no time-zone offset');
  }
  return { dateTime, timeZone: timeZone.trim() };
}
