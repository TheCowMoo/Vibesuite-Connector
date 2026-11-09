import { describe, expect, it } from 'vitest';
import {
  batchRows,
  buildAssignmentPrompt,
  buildTaxonomyPrompt,
  mergeBatchResults,
  parseBatchAssignments,
  parseTaxonomy,
  sampleRows,
  type BatchResult,
} from '../../src/domain/listSegmentBatch';
import { SegmentationFormatError } from '../../src/domain/listSegment';

describe('sampleRows', () => {
  it('returns the whole list when it is smaller than the sample limit', () => {
    expect(sampleRows(['a', 'b'], 500)).toEqual(['a', 'b']);
  });

  it('takes an even spread instead of the first N rows', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => `row-${i}`);
    const sample = sampleRows(rows, 10);
    expect(sample).toHaveLength(10);
    expect(sample[0]).toBe('row-0');
    expect(sample[9]).toBe('row-900');
  });
});

describe('batchRows', () => {
  it('numbers batches and carries the original offsets', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'];
    expect(batchRows(rows, 2)).toEqual([
      { index: 0, offset: 0, rows: ['a', 'b'] },
      { index: 1, offset: 2, rows: ['c', 'd'] },
      { index: 2, offset: 4, rows: ['e'] },
    ]);
  });
});

describe('taxonomy prompts and parsing', () => {
  it('includes criteria and a representative sample', () => {
    const prompt = buildTaxonomyPrompt({
      sample: ['Ada,ada@example.com', 'Grace,grace@example.com'],
      criteria: 'Seniority',
      context: 'Enterprise founders.',
    });
    expect(prompt).toContain('Seniority');
    expect(prompt).toContain('Enterprise founders.');
    expect(prompt).toContain('0: "Ada,ada@example.com"');
    expect(prompt).toContain('Do not return row indexes');
  });

  it('cleans, de-duplicates and limits taxonomy names', () => {
    const raw = {
      segments: [
        { name: ' Hot ', reason: 'Senior' },
        { name: 'hot', reason: 'duplicate' },
        { name: 'Warm', reason: 'Nurture' },
      ],
    };
    expect(parseTaxonomy(raw)).toEqual([
      { name: 'Hot', reason: 'Senior' },
      { name: 'Warm', reason: 'Nurture' },
    ]);
  });

  it('rejects a response without usable taxonomies', () => {
    expect(() => parseTaxonomy({ segments: [] })).toThrow(SegmentationFormatError);
    expect(() => parseTaxonomy({ segments: 'nope' })).toThrow(SegmentationFormatError);
  });
});

describe('assignment parsing', () => {
  it('keeps valid indexes, removes duplicates, and reports skipped rows', () => {
    const parsed = parseBatchAssignments(
      {
        segments: [
          { index: 0, rowIndexes: [0, 0, 4, 99, -1] },
          { segmentIndex: '1', indexes: ['1', '2'] },
        ],
      },
      2,
      4,
    );

    expect(parsed.assignments).toEqual([
      { index: 0, rowIndexes: [0] },
      { index: 1, rowIndexes: [1, 2] },
    ]);
    expect(parsed.assignedRows).toBe(3);
    expect(parsed.warnings[0]).toContain('1 row in this batch');
  });

  it('accepts group names and a rows alias from JSON-mode models', () => {
    const parsed = parseBatchAssignments(
      { segments: [{ name: 'Hot', rows: [0, 1] }] },
      2,
      2,
      ['Hot', 'Warm'],
    );
    expect(parsed.assignments).toEqual([{ index: 0, rowIndexes: [0, 1] }]);
    expect(parsed.assignedRows).toBe(2);
  });

  it('rejects a response with no usable assignments', () => {
    expect(() => parseBatchAssignments({ segments: [] }, 2, 4)).toThrow(SegmentationFormatError);
    expect(() =>
      parseBatchAssignments({ segments: [{ index: 9, rowIndexes: [0] }] }, 2, 4),
    ).toThrow(SegmentationFormatError);
  });

  it('builds an assignment prompt with fixed groups and local indexes', () => {
    const prompt = buildAssignmentPrompt({
      batch: { index: 1, offset: 500, rows: ['Ada', 'Grace'] },
      totalBatches: 3,
      taxonomy: [
        { name: 'Hot', reason: 'Ready to buy' },
        { name: 'Warm', reason: 'Nurture' },
      ],
      criteria: 'Intent',
      context: '',
    });
    expect(prompt).toContain('Batch 2 of 3');
    expect(prompt).toContain('0: Hot - Ready to buy');
    expect(prompt).toContain('0: "Ada"');
    expect(prompt).toContain('1: "Grace"');
  });
});

describe('mergeBatchResults', () => {
  const taxonomy = [
    { name: 'Hot', reason: 'Ready to buy' },
    { name: 'Warm', reason: 'Nurture' },
  ];
  const rows = ['a', 'b', 'c', 'd', 'e'];

  const batch = (index: number, offset: number, assignments: BatchResult['assignments']): BatchResult => ({
    index,
    offset,
    rowCount: Math.min(2, rows.length - offset),
    assignments,
    warnings: [],
  });

  it('maps local batch indexes back to the full list', () => {
    const result = mergeBatchResults(
      taxonomy,
      [
        batch(0, 0, [{ index: 0, rowIndexes: [0] }, { index: 1, rowIndexes: [1] }]),
        batch(1, 2, [{ index: 0, rowIndexes: [0, 1] }]),
        batch(2, 4, [{ index: 1, rowIndexes: [0] }]),
      ],
      rows,
    );

    expect(result.segments).toEqual([
      { name: 'Hot', reason: 'Ready to buy', rows: ['a', 'c', 'd'] },
      { name: 'Warm', reason: 'Nurture', rows: ['b', 'e'] },
    ]);
    expect(result.warnings).toBeUndefined();
  });

  it('puts skipped rows into Unsorted exactly once', () => {
    const result = mergeBatchResults(
      taxonomy,
      [
        batch(0, 0, [{ index: 0, rowIndexes: [0] }]),
        batch(1, 2, [{ index: 0, rowIndexes: [0, 1] }]),
        batch(2, 4, []),
      ],
      rows,
    );

    expect(result.segments.map((segment) => segment.name)).toEqual(['Hot', 'Unsorted']);
    expect(result.segments[1].rows).toEqual(['b', 'e']);
    expect(result.warnings?.join(' ')).toContain('2 rows');
  });

  it('rejects a merge without a taxonomy', () => {
    expect(() => mergeBatchResults([], [], rows)).toThrow(SegmentationFormatError);
  });
});
