import { describe, expect, it } from 'vitest';
import {
  assertSegmentable,
  buildSegmentPrompt,
  listDataRows,
  mergeIndexedSegments,
  SegmentationFormatError,
  SegmentationInputError,
  SEGMENT_MAX_CHARS,
  SEGMENT_MAX_ROWS,
  splitListRows,
} from '../../src/domain/listSegment';

describe('splitListRows', () => {
  it('keeps a quoted CSV newline inside one row', () => {
    const content =
      'Name,Email,Note\n"Ada","ada@example.com","first line\nsecond line"\nGrace,grace@example.com,hi';
    expect(splitListRows(content)).toEqual([
      'Name,Email,Note',
      '"Ada","ada@example.com","first line\nsecond line"',
      'Grace,grace@example.com,hi',
    ]);
  });

  it('handles CRLF, escaped quotes and a BOM', () => {
    const content = '\uFEFF"Ada ""A"" Lovelace",ada@example.com\r\nGrace,grace@example.com\r\n';
    expect(splitListRows(content)).toEqual(['"Ada ""A"" Lovelace",ada@example.com', 'Grace,grace@example.com']);
  });

  it('ignores blank rows', () => {
    expect(splitListRows('one\n\n  \ntwo\n')).toEqual(['one', 'two']);
  });
});

describe('listDataRows', () => {
  it('drops a header row that has no email', () => {
    expect(listDataRows('Email,Company\nada@example.com,Acme\ngrace@example.com,Navy')).toEqual([
      'ada@example.com,Acme',
      'grace@example.com,Navy',
    ]);
  });

  it('keeps a first data row that already contains an email', () => {
    expect(listDataRows('ada@example.com,Ada\ngrace@example.com,Grace')).toEqual([
      'ada@example.com,Ada',
      'grace@example.com,Grace',
    ]);
  });

  it('does not strip the only row', () => {
    expect(listDataRows('Email')).toEqual(['Email']);
  });
});

describe('assertSegmentable', () => {
  it('rejects an empty list', () => {
    expect(() => assertSegmentable([], 0)).toThrow(SegmentationInputError);
    expect(() => assertSegmentable([], 0)).toThrow('no rows');
  });

  it('rejects more rows than one AI sort can handle', () => {
    const rows = Array.from({ length: SEGMENT_MAX_ROWS + 1 }, (_, i) => `person${i}@example.com`);
    expect(() => assertSegmentable(rows, 1000)).toThrow(String(SEGMENT_MAX_ROWS));
  });

  it('rejects an oversized list before sending it to the AI', () => {
    expect(() => assertSegmentable(['ada@example.com'], SEGMENT_MAX_CHARS + 1)).toThrow('too large');
  });

  it('rejects a list with no email addresses', () => {
    expect(() => assertSegmentable(['Name,Company', 'Ada,Acme'], 20)).toThrow('no email addresses');
  });

  it('accepts a normal list', () => {
    expect(() => assertSegmentable(['ada@example.com'], 16)).not.toThrow();
  });
});

describe('buildSegmentPrompt', () => {
  it('numbers rows and instructs the model to return indexes only', () => {
    const prompt = buildSegmentPrompt({
      rows: ['Ada,ada@example.com', 'Grace,grace@example.com'],
      criteria: 'Seniority',
      context: 'Ada is a founder.',
    });

    expect(prompt).toContain('0: "Ada,ada@example.com"');
    expect(prompt).toContain('1: "Grace,grace@example.com"');
    expect(prompt).toContain('Segmentation criteria:\nSeniority');
    expect(prompt).toContain('Ada is a founder.');
    expect(prompt).toContain('Every index from 0 to 1 must appear exactly once');
  });

  it('handles an empty criteria and missing context', () => {
    const prompt = buildSegmentPrompt({ rows: ['ada@example.com'] });
    expect(prompt).toContain('(no criteria - use your best judgment)');
    expect(prompt).toContain('(none)');
  });
});

describe('mergeIndexedSegments', () => {
  const rows = ['Ada,ada@example.com', 'Grace,grace@example.com', 'Alan,alan@example.com'];

  it('maps row indexes back to the original rows', () => {
    const result = mergeIndexedSegments(
      {
        segments: [
          { name: 'Hot', reason: 'Senior titles', rowIndexes: [0, 2] },
          { name: 'Warm', reason: 'Nurture', rowIndexes: [1] },
        ],
      },
      rows,
    );

    expect(result.segments).toEqual([
      { name: 'Hot', reason: 'Senior titles', rows: ['Ada,ada@example.com', 'Alan,alan@example.com'] },
      { name: 'Warm', reason: 'Nurture', rows: ['Grace,grace@example.com'] },
    ]);
  });

  it('merges segments with the same name, ignoring case', () => {
    const result = mergeIndexedSegments(
      {
        segments: [
          { name: 'Hot', rowIndexes: [0] },
          { name: 'hot', reason: 'Second pass', rowIndexes: [1] },
        ],
      },
      rows.slice(0, 2),
    );

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].name).toBe('Hot');
    expect(result.segments[0].reason).toBe('Second pass');
    expect(result.segments[0].rows).toEqual(['Ada,ada@example.com', 'Grace,grace@example.com']);
  });

  it('puts every skipped row into an explicit Unsorted group', () => {
    const result = mergeIndexedSegments({ segments: [{ name: 'Hot', rowIndexes: [0] }] }, rows);

    expect(result.segments).toEqual([
      { name: 'Hot', rows: ['Ada,ada@example.com'] },
      {
        name: 'Unsorted',
        reason: 'Rows the AI did not assign to a group.',
        rows: ['Grace,grace@example.com', 'Alan,alan@example.com'],
      },
    ]);
  });

  it('ignores duplicate and out-of-range indexes and accepts numeric strings', () => {
    const result = mergeIndexedSegments(
      { segments: [{ name: 'Hot', rowIndexes: [0, 0, 99, -1, '1'] }] },
      rows,
    );

    expect(result.segments[0].rows).toEqual(['Ada,ada@example.com', 'Grace,grace@example.com']);
    expect(result.segments[1].name).toBe('Unsorted');
    expect(result.segments[1].rows).toEqual(['Alan,alan@example.com']);
  });

  it('uses a fallback name when the model omits one', () => {
    const result = mergeIndexedSegments({ segments: [{ rowIndexes: [0] }] }, rows);
    expect(result.segments[0].name).toBe('Group 1');
  });

  it('accepts alternate index field names from JSON-mode models', () => {
    const result = mergeIndexedSegments({ segments: [{ name: 'Hot', indexes: [1, 2] }] }, rows);
    expect(result.segments[0].rows).toEqual(['Grace,grace@example.com', 'Alan,alan@example.com']);
  });

  it('rejects a response with no usable indexes', () => {
    expect(() => mergeIndexedSegments({ segments: [] }, rows)).toThrow(SegmentationFormatError);
    expect(() => mergeIndexedSegments({ segments: [{ name: 'Hot', rowIndexes: [99] }] }, rows)).toThrow(
      SegmentationFormatError,
    );
    expect(() => mergeIndexedSegments({ segments: 'nope' }, rows)).toThrow(SegmentationFormatError);
  });
});
