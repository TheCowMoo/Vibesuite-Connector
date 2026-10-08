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
