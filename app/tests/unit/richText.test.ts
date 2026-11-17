import { describe, expect, it } from 'vitest';
import { sanitizeDescription } from '../../src/lib/richText';

describe('sanitizeDescription', () => {
  it('escapes plain text and preserves line breaks', () => {
    expect(sanitizeDescription('Hello <world>\nSecond line')).toBe(
      '<div>Hello &lt;world&gt;<br>Second line</div>',
    );
  });

  it('keeps supported formatting and links', () => {
    const html = '<div><b>Bold</b> <i>Italic</i> <u>Under</u><ul><li>One</li></ul><a href="https://example.com">Site</a></div>';
    expect(sanitizeDescription(html)).toContain('<b>Bold</b>');
    expect(sanitizeDescription(html)).toContain('<i>Italic</i>');
    expect(sanitizeDescription(html)).toContain('<ul><li>One</li></ul>');
    expect(sanitizeDescription(html)).toContain('href="https://example.com"');
  });

  it('removes scripts, styles, event handlers, and unsafe URL schemes', () => {
    const html =
      '<div onclick="alert(1)"><script>alert(1)</script><style>.x{}</style>' +
      '<a href="javascript:alert(1)">bad</a><img src="x" onerror="alert(1)"></div>';
    const clean = sanitizeDescription(html) || '';
    expect(clean).not.toContain('script');
    expect(clean).not.toContain('style');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onerror');
    expect(clean).not.toContain('javascript:');
    expect(clean).toContain('bad');
  });

  it('normalizes bare domains and allows mailto and tel links', () => {
    expect(sanitizeDescription('<a href="example.com">Example</a>')).toContain(
      'href="https://example.com"',
    );
    expect(sanitizeDescription('<a href="mailto:hi@example.com">Email</a>')).toContain(
      'href="mailto:hi@example.com"',
    );
    expect(sanitizeDescription('<a href="tel:+15551234567">Call</a>')).toContain(
      'href="tel:+15551234567"',
    );
  });

  it('strips unsupported tags while keeping their text', () => {
    expect(sanitizeDescription('<span>Keep <strong>this</strong></span>')).toBe(
      'Keep <strong>this</strong>',
    );
  });

  it('does not double-escape HTML entities from the editor', () => {
    expect(sanitizeDescription('A &lt; B &amp; C')).toBe('<div>A &lt; B &amp; C</div>');
    expect(sanitizeDescription('Use &amp; enjoy')).toContain('&amp;');
  });

  it('returns undefined for an absent description and empty for blank text', () => {
    expect(sanitizeDescription(undefined)).toBeUndefined();
    expect(sanitizeDescription('  \n ')).toBe('');
  });
});
