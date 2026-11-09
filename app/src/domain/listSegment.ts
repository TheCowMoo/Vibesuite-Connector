/**
 * List segmentation is deliberately split into two steps:
 *
 * 1. The AI sees numbered rows and returns only row indexes.
 * 2. This module maps those indexes back to the original rows.
 *
 * Asking the model to echo every row made the response large enough to be
 * truncated and made CSV quotes/newlines part of the JSON. Indexes keep the
 * response small and let the server guarantee that every row appears once.
 */

export const SEGMENT_MAX_ROWS = 2000;
export const SEGMENT_MAX_CHARS = 250_000;

/** Hard cap for an uploaded list. Larger lists are split by the operator. */
export const LIST_MAX_ROWS = 50_000;
/** Matches the Fastify/Nginx request body limit. */
export const LIST_MAX_CHARS = 25 * 1024 * 1024;
/** Lists at or below this size use the immediate single-request path. */
export const SEGMENT_SYNC_MAX_ROWS = SEGMENT_MAX_ROWS;

export interface Segment {
  name: string;
  reason?: string;
  rows: string[];
}

export interface SegmentationResult {
  segments: Segment[];
  warnings?: string[];
}

export class SegmentationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentationInputError';
  }
}

export class SegmentationFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SegmentationFormatError';
  }
}

/**
 * Split a TXT/CSV upload into logical rows. Newlines inside a quoted CSV field
 * are part of the row, not a row separator. Blank rows are ignored.
 */
export function splitListRows(content: string): string[] {
  const text = (content || '').replace(/^\uFEFF/, '');
  const rows: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '""';
        i += 1;
      } else {
        inQuotes = !inQuotes;
        current += ch;
      }
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      if (current.trim()) rows.push(current.trim());
      current = '';
      continue;
    }

    current += ch;
  }

  if (current.trim()) rows.push(current.trim());
  return rows;
}

/**
 * Most CSV exports start with a header row that has no email. If the first row
 * has no email but a later row does, treat the first row as a header and keep it
 * out of the segmentation indexes.
 */
export function listDataRows(content: string): string[] {
  const rows = splitListRows(content);
  if (!rows.length) return rows;
  if (!/@/.test(rows[0]) && rows.slice(1).some((row) => /@/.test(row))) {
    return rows.slice(1);
  }
  return rows;
}

export function assertSegmentable(
  rows: string[],
  contentLength: number,
  maxRows = SEGMENT_MAX_ROWS,
  maxChars = SEGMENT_MAX_CHARS,
): void {
  if (!rows.length) {
    throw new SegmentationInputError('This list has no rows to sort.');
  }
  if (!rows.some((row) => /@/.test(row))) {
    throw new SegmentationInputError('This list has no email addresses to sort.');
  }
  if (rows.length > maxRows) {
    throw new SegmentationInputError(
      `This list has ${rows.length} rows. AI sorting handles up to ${maxRows} rows per list; split it into smaller lists and sort each one.`,
    );
  }
  if (contentLength > maxChars) {
    throw new SegmentationInputError(
      `This list is too large for one AI sort (${contentLength} characters; limit ${maxChars}). Split it into smaller lists and sort each one.`,
    );
  }
}

/** Upload validation only checks size; a list with no emails is rejected when sorting starts. */
export function assertListSize(rows: string[], contentLength: number): void {
  if (!rows.length) {
    throw new SegmentationInputError('This list has no rows.');
  }
  if (rows.length > LIST_MAX_ROWS) {
    throw new SegmentationInputError(
      `This list has ${rows.length} rows. The maximum is ${LIST_MAX_ROWS} rows; split the file into smaller lists.`,
    );
  }
  if (contentLength > LIST_MAX_CHARS) {
    throw new SegmentationInputError(
      `This list is too large (${contentLength} characters; limit ${LIST_MAX_CHARS}).`,
    );
  }
}

export const SEGMENT_SYSTEM_PROMPT =
  'You are a lead list segmentation engine. You receive numbered rows. Group them by the supplied criteria. ' +
  'Return ONLY JSON in this exact shape: {"segments":[{"name":"...","reason":"...","rowIndexes":[0,1,2]}]}. ' +
  'Every input row index must appear in exactly one segment. Indexes are zero-based, exactly as shown in the numbered input. ' +
  'Do not repeat row text, do not include markdown, and do not invent indexes.';

export interface SegmentPromptInput {
  rows: string[];
  criteria?: string;
  context?: string;
}

export function buildSegmentPrompt(input: SegmentPromptInput): string {
  const numbered = input.rows.map((row, index) => `${index}: ${JSON.stringify(row)}`).join('\n');
  const criteria = (input.criteria || '').trim() || '(no criteria - use your best judgment)';
  const context = (input.context || '').trim() || '(none)';

  return [
    'Knowledge base context:',
    context,
    '',
    'Segmentation criteria:',
    criteria,
    '',
    'Numbered rows (index: JSON-encoded row):',
    numbered,
    '',
    `Return only the JSON object. Every index from 0 to ${input.rows.length - 1} must appear exactly once.`,
  ].join('\n');
}

interface IndexedSegment {
  name: string;
  reason: string;
  indexes: number[];
}

function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return (name || fallback).slice(0, 80);
}

function cleanReason(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
}

function normalizeIndex(value: unknown, rowCount: number): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 0 && parsed < rowCount ? parsed : null;
}

/**
 * Validate the model's index-only response, de-duplicate multiple assignments,
 * and put any rows the model skipped into an explicit "Unsorted" group. The
 * returned result always contains every row exactly once.
 */
export function mergeIndexedSegments(raw: unknown, rows: string[]): SegmentationResult {
  const rawSegments = (raw as { segments?: unknown } | null | undefined)?.segments;
  if (!Array.isArray(rawSegments)) {
    throw new SegmentationFormatError('The AI did not return a segments array.');
  }

  const byName = new Map<string, IndexedSegment>();
  const assigned = new Set<number>();
  let validSegments = 0;

  rawSegments.forEach((value, position) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const candidate = value as {
      name?: unknown;
      reason?: unknown;
      rowIndexes?: unknown;
      row_indexes?: unknown;
      indexes?: unknown;
      indices?: unknown;
    };
    const rawIndexes = [candidate.rowIndexes, candidate.row_indexes, candidate.indexes, candidate.indices].find(
      (item) => Array.isArray(item),
    ) as unknown[] | undefined;
    if (!rawIndexes) return;

    const indexes: number[] = [];
    for (const rawIndex of rawIndexes) {
      const index = normalizeIndex(rawIndex, rows.length);
      if (index === null || assigned.has(index)) continue;
      assigned.add(index);
      indexes.push(index);
    }
    if (!indexes.length) return;

    const name = cleanName(candidate.name, `Group ${position + 1}`);
    const reason = cleanReason(candidate.reason);
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      existing.indexes.push(...indexes);
      if (!existing.reason && reason) existing.reason = reason;
    } else {
      byName.set(key, { name, reason, indexes });
    }
    validSegments += 1;
  });

  if (!validSegments) {
    throw new SegmentationFormatError('The AI did not return any usable row indexes.');
  }

  const missing: number[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!assigned.has(index)) missing.push(index);
  }
  if (missing.length) {
    const unsorted = byName.get('unsorted');
    if (unsorted) {
      unsorted.indexes.push(...missing);
      if (!unsorted.reason) unsorted.reason = 'Rows the AI did not assign to a group.';
    } else {
      byName.set('unsorted', {
        name: 'Unsorted',
        reason: 'Rows the AI did not assign to a group.',
        indexes: missing,
      });
    }
  }

  const segments = Array.from(byName.values()).map((segment) => ({
    name: segment.name,
    ...(segment.reason ? { reason: segment.reason } : {}),
    rows: segment.indexes.sort((a, b) => a - b).map((index) => rows[index]),
  }));

  return { segments };
}
