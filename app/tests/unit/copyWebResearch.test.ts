import { describe, expect, it } from 'vitest';
import {
  buildCopyResearchQueries,
  formatWebResearch,
  normalizeTavilyResults,
} from '../../src/domain/copyWebResearch';

describe('copy web research', () => {
  it('builds generic objective-aware queries without campaign or recipient data', () => {
    const showUp = buildCopyResearchQueries('show_up');
    expect(showUp.join(' ')).toContain('no-shows');
    expect(showUp.join(' ')).not.toContain('@');
    expect(showUp.join(' ')).not.toContain('Campaign');

    const replies = buildCopyResearchQueries('replies');
    expect(replies.join(' ')).toContain('qualified replies');
  });

  it('dedupes, validates and caps provider results', () => {
    const out = normalizeTavilyResults(
      {
        results: [
          { title: 'First', url: 'https://example.com/a', content: 'One' },
          { title: 'Duplicate', url: 'https://example.com/a/', content: 'Two' },
          { title: 'Bad URL', url: 'javascript:alert(1)', content: 'No' },
          { title: 'Second', url: 'http://example.org/b', content: 'Three', published_date: '2026-01-01' },
        ],
      },
      2,
    );

    expect(out).toEqual([
      { id: 'web1', title: 'First', url: 'https://example.com/a', snippet: 'One' },
      {
        id: 'web2',
        title: 'Second',
        url: 'http://example.org/b',
        snippet: 'Three',
        publishedAt: '2026-01-01',
      },
    ]);
  });

  it('formats sources with stable citation ids', () => {
    const text = formatWebResearch({
      enabled: true,
      available: true,
      sources: [{ id: 'web1', title: 'Guide', url: 'https://example.com', snippet: 'Useful' }],
    });
    expect(text).toBe('[web1] Guide — https://example.com — Useful');
    expect(formatWebResearch(null)).toBe('');
  });

});
