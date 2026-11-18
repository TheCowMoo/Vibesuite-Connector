import type { CopyEvidence, CopyObjective, CopySuggestionMode } from './copyEvidence';
import type { CopyPatterns } from './copyPatterns';
import { CURATED_COPY_BEST_PRACTICES } from './copyResearch';
import type { CopyWebResearch } from './copyWebResearch';

export type CopySuggestionConfidence = 'low' | 'medium' | 'high';
export type CopySuggestionKind = 'rewrite' | 'challenger';

export interface CopySuggestion {
  id: string;
  mode: CopySuggestionKind;
  summary: string;
  description: string;
  rationale: string;
  evidence: string[];
  tradeoffs: string[];
  confidence: CopySuggestionConfidence;
  warnings: string[];
  subjectChars: number;
  /** IDs of supplied web sources cited by the model; empty when no web research was used. */
  sourceIds: string[];
}

export interface CopySuggestionPromptInput {
  evidence: CopyEvidence;
  knowledgeContext: string;
  mode: CopySuggestionMode;
  objective: CopyObjective;
  count: number;
  /** Observational patterns from other campaigns; never a substitute for current evidence. */
  historicalPatterns?: CopyPatterns;
  /** Optional cited web research; supplementary to current and historical evidence. */
  webResearch?: CopyWebResearch | null;
}

const HARD_SUBJECT_MAX = 120;
const HARD_DESCRIPTION_MAX = 2000;
const SOFT_SUBJECT_MAX = 80;
const SOFT_DESCRIPTION_MAX = 1200;

const SPAM_WORDS =
  /\b(guarantee|guaranteed|100%|risk[- ]free|act now|limited time|free money|no obligation|click here|buy now|last chance|only \d+ (spots|seats))\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

export const COPY_SUGGESTION_SYSTEM =
  'You are a senior B2B event copywriter. You write short Google Calendar invitation copy. ' +
  'You use the supplied evidence and notes, never invent metrics or links, and you are comfortable ' +
  'saying that the current copy should stay when the evidence is weak.';

function cleanText(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function warningList(
  summary: string,
  description: string,
  hadUrl: boolean,
  subjectTrimmed: boolean,
  descriptionTrimmed: boolean,
): string[] {
  const warnings: string[] = [];
  if (hadUrl) {
    warnings.push('Removed a link from the suggestion. Add registration links yourself in the variant link field.');
  }
  if (subjectTrimmed) warnings.push(`The subject was shortened to ${HARD_SUBJECT_MAX} characters.`);
  if (descriptionTrimmed) warnings.push(`The description was shortened to ${HARD_DESCRIPTION_MAX} characters.`);
  if (summary.length > SOFT_SUBJECT_MAX) {
    warnings.push(`The subject is ${summary.length} characters; many calendar clients truncate long subjects.`);
  }
  if (description.length > SOFT_DESCRIPTION_MAX) {
    warnings.push('The description is long for a calendar invite; consider trimming it.');
  }
  if (SPAM_WORDS.test(`${summary} ${description}`)) {
    warnings.push('Contains wording often treated as promotional or spammy. Review before using.');
  }
  if (EMOJI_RE.test(`${summary} ${description}`)) {
    warnings.push('Contains an emoji; check it fits your brand and audience.');
  }
  if (/[!?]{3,}/.test(`${summary} ${description}`)) {
    warnings.push('Contains repeated exclamation/question marks.');
  }
  const letters = summary.replace(/[^a-zA-Z]/g, '');
  if (letters.length >= 10 && letters === letters.toUpperCase()) {
    warnings.push('The subject is mostly uppercase.');
  }
  if (/\{\{|\}\}|\[[A-Z_]+\]/.test(`${summary} ${description}`)) {
    warnings.push('Looks like a personalization token; a Calendar description is shared by every recipient.');
  }
  return warnings;
}

function normalizedCopy(summary: string, description: string): string {
  return `${summary.toLowerCase().replace(/\s+/g, ' ').trim()}|${description.toLowerCase().replace(/\s+/g, ' ').trim()}`;
}

function formatSources(research: CopyWebResearch | null | undefined): string {
  if (!research?.available || !research.sources.length) return '(none)';
  return research.sources
    .map((source) => `[${source.id}] ${source.title} — ${source.url}${source.snippet ? ` — ${source.snippet}` : ''}`)
    .join('\n');
}

export function buildCopySuggestionPrompt(input: CopySuggestionPromptInput): string {
  const objective =
    input.objective === 'replies'
      ? 'more qualified replies (acceptance and yes quality)'
      : input.objective === 'show_up'
        ? 'better Zoom show-up among the people who say yes or maybe'
        : 'a balanced result: qualified replies and show-up';

  return [
    'Write Google Calendar invitation copy for the campaign below.',
    '',
    `Objective: ${objective}.`,
    `Mode: ${input.mode}. Return ${input.count} distinct suggestion${input.count === 1 ? '' : 's'} when the evidence supports them.`,
    '',
    'Evidence rules:',
    '- Use the numbers supplied. Do not invent metrics, comparisons, dates, testimonials or links.',
    '- Current campaign evidence outranks general guidance.',
    '- If the evidence is weak, say so in the rationale and lower the confidence. Returning no suggestions is allowed.',
    '- Never claim statistical significance from a small sample; say "directional".',
    '- Attendance is not measured when hasAttendance is false; do not treat missing attendance as zero.',
    '- If variants differ in more than one element, do not describe the result as a controlled test.',
    '- Historical patterns are observational, not causal. Cite their sample sizes and never let them override current-campaign evidence.',
    '- Web sources are supplementary and may conflict. Use only the supplied source IDs, never invent a URL, and do not treat one article as proof.',
    '',
    'Copy rules:',
    '- Only propose subject (summary) and description. Never propose a registration URL, date, time or location.',
    '- A Calendar description is shared by every recipient; do not use merge/personalization tokens.',
    '- Prefer clarity, a specific audience and a concrete outcome. Avoid guarantees, fake scarcity and unsupported claims.',
    '- Do not add links. The operator adds links in the variant link field.',
    '- There is no universal subject-length rule; flag trade-offs instead of refusing to write.',
    '',
    'Curated guidance to weigh (not hard rules):',
    ...CURATED_COPY_BEST_PRACTICES.map((line) => `- ${line}`),
    '',
    'Knowledge-base context:',
    input.knowledgeContext || '(none)',
    '',
    'Campaign evidence (aggregate only; contains no personal data):',
    JSON.stringify(input.evidence, null, 2),
    '',
    'Historical patterns from other campaigns (observational; may be empty):',
    input.historicalPatterns && input.historicalPatterns.patterns.length
      ? JSON.stringify(input.historicalPatterns, null, 2)
      : '(none)',
    '',
    'Web research sources (optional; cite only these ids):',
    formatSources(input.webResearch),
    '',
    'Return JSON shaped exactly like:',
    '{"summary":"one paragraph overall read",',
    ' "suggestions":[{"mode":"rewrite|challenger",',
    ' "summary":"subject", "description":"description",',
    ' "rationale":"why, citing the evidence",',
    ' "evidence":["short citation of a supplied number"],',
    ' "tradeoffs":["what this may sacrifice or confound"],',
    ' "confidence":"low|medium|high","sourceIds":["web1"]}]}',
  ].join('\n');
}

/**
 * Sanitize model output into copy the operator may choose to apply.
 *
 * The model never gets a direct write path. These checks remove links/markup, enforce only real
 * technical caps, and turn stylistic concerns into warnings the human can judge.
 */
export function sanitizeCopySuggestions(
  raw: unknown,
  currentCopy: Array<{ summary: string; description?: string }>,
  mode: CopySuggestionMode,
  max = 3,
  allowedSourceIds?: string[],
): CopySuggestion[] {
  const suggestions = Array.isArray((raw as { suggestions?: unknown })?.suggestions)
    ? ((raw as { suggestions: Array<Record<string, unknown>> }).suggestions)
    : [];
  const current = new Set(
    currentCopy.map((item) =>
      normalizedCopy(
        cleanText(item.summary, HARD_SUBJECT_MAX),
        cleanText(item.description, HARD_DESCRIPTION_MAX),
      ),
    ),
  );
  const seen = new Set<string>();
  const out: CopySuggestion[] = [];
  const limit = Math.max(1, Math.min(3, Math.floor(max)));

  for (const item of suggestions) {
    if (!item || typeof item !== 'object') continue;
    const rawSummary = String(item.summary ?? '');
    const rawDescription = String(item.description ?? '');
    const hadUrl = /(https?:\/\/|www\.)\S+/i.test(`${rawSummary} ${rawDescription}`);
    let summary = cleanText(rawSummary, HARD_SUBJECT_MAX + 1).replace(/\s+/g, ' ');
    let description = cleanText(rawDescription, HARD_DESCRIPTION_MAX + 1);
    if (!summary) continue;

    const subjectTrimmed = summary.length > HARD_SUBJECT_MAX;
    const descriptionTrimmed = description.length > HARD_DESCRIPTION_MAX;
    summary = summary.slice(0, HARD_SUBJECT_MAX).trim();
    description = description.slice(0, HARD_DESCRIPTION_MAX).trim();
    if (!summary) continue;

    const key = normalizedCopy(summary, description);
    if (current.has(key) || seen.has(key)) continue;
    seen.add(key);

    const modelMode = String(item.mode ?? '').toLowerCase() === 'challenger' ? 'challenger' : 'rewrite';
    const normalizedMode: CopySuggestionKind =
      mode === 'improve' ? 'rewrite' : mode === 'challenger' ? 'challenger' : modelMode;

    const evidence = Array.isArray(item.evidence)
      ? item.evidence.map((value) => cleanText(value, 300)).filter(Boolean).slice(0, 6)
      : [];
    const tradeoffs = Array.isArray(item.tradeoffs)
      ? item.tradeoffs.map((value) => cleanText(value, 300)).filter(Boolean).slice(0, 4)
      : [];
    const allowed = new Set(allowedSourceIds ?? []);
    const sourceIds = Array.isArray(item.sourceIds)
      ? item.sourceIds
          .map((value) => String(value).trim())
          .filter((value) => allowed.has(value))
          .slice(0, 5)
      : [];
    const confidenceRaw = String(item.confidence ?? '').toLowerCase();
    const confidence: CopySuggestionConfidence =
      confidenceRaw === 'high' || confidenceRaw === 'medium' ? confidenceRaw : 'low';

    out.push({
      id: `s${out.length + 1}`,
      mode: normalizedMode,
      summary,
      description,
      rationale: cleanText(item.rationale, 1200) || 'No rationale was supplied.',
      evidence,
      tradeoffs,
      confidence,
      warnings: warningList(summary, description, hadUrl, subjectTrimmed, descriptionTrimmed),
      subjectChars: summary.length,
      sourceIds,
    });

    if (out.length >= limit) break;
  }

  return out;
}
