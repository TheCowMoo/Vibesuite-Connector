export function extractJson(text: string): string {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const pairs: Array<[string, string]> = [
    ['{', '}'],
    ['[', ']'],
  ];
  for (const [open, close] of pairs) {
    const s = t.indexOf(open);
    const e = t.lastIndexOf(close);
    if (s >= 0 && e > s) return t.slice(s, e + 1);
  }
  return t;
}
