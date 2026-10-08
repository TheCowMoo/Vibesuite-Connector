export interface RetrievableDoc {
  name: string;
  content: string;
}

/** Naive keyword-based retrieval (no vector DB). Returns the best-matching docs up to maxChars. */
export function retrieveContext(docs: RetrievableDoc[], query: string, maxChars = 6000): string {
  if (!docs.length) return '';

  const q = query.toLowerCase().split(/\W+/).filter(Boolean);
  const scored = docs
    .map((d) => ({ d, hits: q.filter((w) => d.content.toLowerCase().includes(w)).length }))
    .filter((x) => x.hits > 0)
    .sort((a, b) => b.hits - a.hits);

  let out = '';
  for (const { d } of scored) {
    const chunk = `--- ${d.name} ---\n${d.content}\n\n`;
    if ((out + chunk).length > maxChars) break;
    out += chunk;
  }
  return out;
}
