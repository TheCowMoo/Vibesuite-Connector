const ALLOWED_TAGS = new Set([
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'br',
  'p',
  'div',
  'ul',
  'ol',
  'li',
  'a',
]);

const DROP_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math']);
const TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;

function escapeText(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return '&quot;';
    }
  });
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/'/g, '&#39;');
}

function safeHref(raw: string): string {
  const value = decodeEntities(raw).trim();
  if (/^(https?:\/\/|mailto:|tel:)/i.test(value)) return value;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return '';
  if (/^\/\/[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) return `https:${value}`;
  if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value)) return `https://${value}`;
  return '';
}

function hrefAttribute(attrs: string): string {
  const match = attrs.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  return safeHref(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
}

function hasMarkup(value: string): boolean {
  return /<\/?(?:b|strong|i|em|u|s|strike|del|br|p|div|ul|ol|li|a|span|script|style|iframe|object|embed|template|svg|math|img|h[1-6]|blockquote|hr)\b[^>]*>/i.test(
    value,
  );
}

function hasEntity(value: string): boolean {
  return /&(?:amp|lt|gt|quot|nbsp|#\d+|#x[0-9a-f]+);/i.test(value);
}

function closeTags(out: string, stack: string[], tag: string): string {
  const index = stack.lastIndexOf(tag);
  if (index < 0) return out;
  while (stack.length > index) out += `</${stack.pop()}>`;
  return out;
}

function sanitizeMarkup(value: string): string {
  let out = '';
  let last = 0;
  let match: RegExpExecArray | null;
  const stack: string[] = [];
  TAG_RE.lastIndex = 0;

  while ((match = TAG_RE.exec(value))) {
    out += value.slice(last, match.index);
    last = TAG_RE.lastIndex;

    const raw = match[0];
    const tag = match[1].toLowerCase();
    const closing = /^<\//.test(raw);
    const selfClosing = /\/\s*>$/.test(raw) || tag === 'br';

    if (DROP_TAGS.has(tag)) {
      if (!closing) {
        const lower = value.toLowerCase();
        const closeStart = lower.indexOf(`</${tag}`, last);
        if (closeStart >= 0) {
          const closeEnd = value.indexOf('>', closeStart);
          last = closeEnd >= 0 ? closeEnd + 1 : value.length;
        } else {
          last = value.length;
        }
        TAG_RE.lastIndex = last;
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown/unsupported formatting is unwrapped: keep the text, drop the tag.
      continue;
    }

    if (tag === 'br') {
      if (!closing) out += '<br>';
      continue;
    }

    if (tag === 'a') {
      if (closing) {
        out = closeTags(out, stack, 'a');
      } else {
        const href = hrefAttribute(match[2] || '');
        if (href) {
          out += `<a href="${escapeAttribute(href)}" rel="noopener noreferrer">`;
          if (selfClosing) out += '</a>';
          else stack.push('a');
        }
      }
      continue;
    }

    if (closing) {
      out = closeTags(out, stack, tag);
    } else {
      out += `<${tag}>`;
      if (selfClosing) out += `</${tag}>`;
      else stack.push(tag);
    }
  }

  out += value.slice(last);
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

/**
 * Normalize a calendar description to the small HTML subset the editor exposes.
 *
 * Plain-text values from older records are escaped and wrapped, so they cannot become markup
 * accidentally. Existing HTML is passed through an allowlist: no scripts, event handlers, styles,
 * unsafe URL schemes, or unknown tags. Google Calendar's API accepts HTML in `description`.
 */
export function sanitizeDescription(input: string | undefined | null): string | undefined {
  if (input == null) return undefined;
  const text = String(input).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!text) return '';
  if (!hasMarkup(text)) {
    if (hasEntity(text)) {
      return `<div>${sanitizeMarkup(text).trim().replace(/\n/g, '<br>')}</div>`;
    }
    return `<div>${escapeText(text).replace(/\n/g, '<br>')}</div>`;
  }
  return sanitizeMarkup(text).trim();
}
