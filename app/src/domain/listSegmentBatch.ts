import { SegmentationFormatError, type Segment, type SegmentationResult } from './listSegment';

export interface TaxonomySegment {
  name: string;
  reason: string;
}

export interface BatchChunk {
  index: number;
  offset: number;
  rows: string[];
}

export interface BatchAssignment {
  index: number;
  rowIndexes: number[];
}

export interface BatchResult {
  index: number;
  offset: number;
  rowCount: number;
  assignments: BatchAssignment[];
  warnings: string[];
}

export const TAXONOMY_SYSTEM_PROMPT =
  'You are a lead list segmentation engine. Define a small set of mutually useful groups for the supplied list. ' +
  'Return ONLY JSON in this exact shape: {"segments":[{"name":"...","reason":"..."}]}. ' +
  'Use 3 to 8 groups when the sample supports them, use short distinct names, and do not include row data or row indexes.';

export const ASSIGNMENT_SYSTEM_PROMPT =
  'You are a lead list segmentation engine. Assign every numbered row to exactly one of the supplied groups. ' +
  'Return ONLY JSON in this exact shape: {"segments":[{"index":0,"rowIndexes":[0,4,9]}]}. ' +
  'The index must be a group index from the supplied list. Every local row index must appear exactly once. ' +
  'Do not repeat row text, do not include markdown, and do not invent indexes.';

function cleanName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return name.slice(0, 80);
}

function cleanReason(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
}

function numberValue(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Pick a deterministic, evenly spread sample. A contiguous first-N sample would be biased when
 * the upload is sorted by company, industry, or signup date.
 */
export function sampleRows(rows: string[], limit: number): string[] {
  if (limit <= 0) return [];
  if (rows.length <= limit) return rows.slice();
  const picked: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const index = Math.floor((i * rows.length) / limit);
    picked.push(rows[Math.min(rows.length - 1, index)]);
  }
  return picked;
}

export function batchRows(rows: string[], size: number): BatchChunk[] {
  const batchSize = Math.max(1, Math.floor(size) || 1);
  const batches: BatchChunk[] = [];
  for (let offset = 0, index = 0; offset < rows.length; offset += batchSize, index += 1) {
    batches.push({ index, offset, rows: rows.slice(offset, offset + batchSize) });
  }
  return batches;
}

export interface TaxonomyPromptInput {
  sample: string[];
  criteria?: string;
  context?: string;
}

export function buildTaxonomyPrompt(input: TaxonomyPromptInput): string {
  const criteria = (input.criteria || '').trim() || '(no criteria - use your best judgment)';
  const context = (input.context || '').trim() || '(none)';
  const sample = input.sample.map((row, index) => `${index}: ${JSON.stringify(row)}`).join('\n');
  return [
    'Knowledge base context:',
    context,
    '',
    'Segmentation criteria:',
    criteria,
    '',
    `Representative sample (${input.sample.length} rows):`,
    sample,
    '',
    'Return only the JSON group definition. Do not return row indexes or row text.',
  ].join('\n');
}

export function parseTaxonomy(raw: unknown): TaxonomySegment[] {
  const rawSegments = (raw as { segments?: unknown } | null | undefined)?.segments;
  if (!Array.isArray(rawSegments)) {
    throw new SegmentationFormatError('The AI did not return a segment taxonomy.');
  }

  const seen = new Set<string>();
  const out: TaxonomySegment[] = [];
  for (const value of rawSegments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as { name?: unknown; reason?: unknown };
    const name = cleanName(candidate.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, reason: cleanReason(candidate.reason) || name });
    if (out.length >= 10) break;
  }

  if (!out.length) {
    throw new SegmentationFormatError('The AI did not return any usable segment names.');
  }
  return out;
}

export interface AssignmentPromptInput {
  batch: BatchChunk;
  totalBatches: number;
  taxonomy: TaxonomySegment[];
  criteria?: string;
  context?: string;
}

export function buildAssignmentPrompt(input: AssignmentPromptInput): string {
  const criteria = (input.criteria || '').trim() || '(no criteria - use your best judgment)';
  const context = (input.context || '').trim() || '(none)';
  const groups = input.taxonomy.map((group, index) => `${index}: ${group.name} - ${group.reason}`).join('\n');
  const rows = input.batch.rows.map((row, index) => `${index}: ${JSON.stringify(row)}`).join('\n');
  return [
    'Knowledge base context:',
    context,
    '',
    'Segmentation criteria:',
    criteria,
    '',
    'Fixed groups (use these indexes and names):',
    groups,
    '',
    `Batch ${input.batch.index + 1} of ${input.totalBatches}. Numbered rows (index: JSON-encoded row):`,
    rows,
    '',
    `Return only the JSON object. Every local index from 0 to ${input.batch.rows.length - 1} must appear exactly once.`,
  ].join('\n');
}

export interface ParsedBatch {
  assignments: BatchAssignment[];
  assignedRows: number;
  warnings: string[];
}

function normalizeLocalIndex(value: unknown, rowCount: number): number | null {
  const parsed = numberValue(value);
  return parsed !== null && parsed >= 0 && parsed < rowCount ? parsed : null;
}

export function parseBatchAssignments(
  raw: unknown,
  taxonomySize: number,
  batchSize: number,
  taxonomyNames: string[] = [],
): ParsedBatch {
  const rawSegments = (raw as { segments?: unknown } | null | undefined)?.segments;
  if (!Array.isArray(rawSegments)) {
    throw new SegmentationFormatError('The AI did not return batch assignments.');
  }

  const assignments = new Map<number, number[]>();
  const assigned = new Set<number>();

  for (const value of rawSegments) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const candidate = value as {
      index?: unknown;
      segmentIndex?: unknown;
      name?: unknown;
      rowIndexes?: unknown;
      row_indexes?: unknown;
      indexes?: unknown;
      indices?: unknown;
      rows?: unknown;
    };
    let groupIndex = numberValue(candidate.index ?? candidate.segmentIndex);
    if (groupIndex === null && typeof candidate.name === 'string') {
      const wanted = candidate.name.trim().toLowerCase();
      const found = taxonomyNames.findIndex((name) => name.trim().toLowerCase() === wanted);
      if (found >= 0) groupIndex = found;
    }
    if (groupIndex === null || groupIndex < 0 || groupIndex >= taxonomySize) continue;
    const rawIndexes = [
      candidate.rowIndexes,
      candidate.row_indexes,
      candidate.indexes,
      candidate.indices,
      candidate.rows,
    ].find((item) => Array.isArray(item)) as unknown[] | undefined;
    if (!rawIndexes) continue;

    const localIndexes = assignments.get(groupIndex) ?? [];
    for (const rawIndex of rawIndexes) {
      const localIndex = normalizeLocalIndex(rawIndex, batchSize);
      if (localIndex === null || assigned.has(localIndex)) continue;
      assigned.add(localIndex);
      localIndexes.push(localIndex);
    }
    if (localIndexes.length) assignments.set(groupIndex, localIndexes);
  }

  if (!assigned.size) {
    throw new SegmentationFormatError('The AI returned no usable row assignments.');
  }

  const warnings: string[] = [];
  if (assigned.size < batchSize) {
    warnings.push(
      `${batchSize - assigned.size} row${batchSize - assigned.size === 1 ? '' : 's'} in this batch were not assigned by the AI and will be marked Unsorted.`,
    );
  }

  return {
    assignments: Array.from(assignments.entries())
      .map(([index, rowIndexes]) => ({ index, rowIndexes: rowIndexes.sort((a, b) => a - b) }))
      .sort((a, b) => a.index - b.index),
    assignedRows: assigned.size,
    warnings,
  };
}

/**
 * Turn per-batch local indexes into one result over the original list. Every row is included
 * exactly once; anything the model skipped is placed in an explicit Unsorted group.
 */
export function mergeBatchResults(
  taxonomy: TaxonomySegment[],
  batches: BatchResult[],
  rows: string[],
): SegmentationResult {
  if (!taxonomy.length) {
    throw new SegmentationFormatError('Cannot merge assignments without a segment taxonomy.');
  }

  const byGroup = taxonomy.map(() => new Set<number>());
  const seen = new Set<number>();
  const warnings = new Set<string>();

  for (const batch of batches.slice().sort((a, b) => a.index - b.index)) {
    for (const warning of batch.warnings) warnings.add(warning);
    for (const assignment of batch.assignments) {
      if (assignment.index < 0 || assignment.index >= taxonomy.length) continue;
      for (const localIndex of assignment.rowIndexes) {
        const globalIndex = batch.offset + localIndex;
        if (!Number.isInteger(globalIndex) || globalIndex < 0 || globalIndex >= rows.length) continue;
        if (seen.has(globalIndex)) continue;
        seen.add(globalIndex);
        byGroup[assignment.index].add(globalIndex);
      }
    }
  }

  const segments: Segment[] = [];
  taxonomy.forEach((group, index) => {
    const indexes = Array.from(byGroup[index]).sort((a, b) => a - b);
    if (!indexes.length) return;
    segments.push({
      name: group.name,
      reason: group.reason,
      rows: indexes.map((rowIndex) => rows[rowIndex]),
    });
  });

  const missing: string[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!seen.has(index)) missing.push(rows[index]);
  }
  if (missing.length) {
    warnings.add(
      `${missing.length} row${missing.length === 1 ? '' : 's'} were not assigned by the AI and were placed in Unsorted.`,
    );
    segments.push({
      name: 'Unsorted',
      reason: 'Rows the AI did not assign to a group.',
      rows: missing,
    });
  }

  return {
    segments,
    ...(warnings.size ? { warnings: Array.from(warnings) } : {}),
  };
}
