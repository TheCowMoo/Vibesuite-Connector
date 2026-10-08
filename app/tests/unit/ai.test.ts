import { describe, it, expect } from 'vitest';
import { extractJson } from '../../src/lib/json';
import { retrieveContext } from '../../src/domain/retrieval';
import type { RetrievableDoc } from '../../src/domain/retrieval';

describe('extractJson', () => {
  it('returns plain JSON unchanged', () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
  });

  it('strips markdown fences', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it('extracts JSON embedded in prose', () => {
    expect(extractJson('Here: {"segments":[{"name":"Hot"}]} thanks')).toBe('{"segments":[{"name":"Hot"}]}');
  });

  it('handles arrays', () => {
    expect(extractJson('```\n[1,2,3]\n```')).toBe('[1,2,3]');
  });
});

describe('retrieveContext', () => {
  const docs: RetrievableDoc[] = [
    { name: 'pricing', content: 'Our pricing starts at $99 per month for the starter plan.' },
    { name: 'about', content: 'We are a software company.' },
  ];

  it('returns matching docs labelled with their name', () => {
    const ctx = retrieveContext(docs, 'pricing');
    expect(ctx).toContain('--- pricing ---');
    expect(ctx).toContain('$99');
    expect(ctx).not.toContain('--- about ---');
  });

  it('returns empty string when nothing matches', () => {
    expect(retrieveContext(docs, 'zebra')).toBe('');
  });

  it('returns empty string for empty docs', () => {
    expect(retrieveContext([], 'anything')).toBe('');
  });
});
