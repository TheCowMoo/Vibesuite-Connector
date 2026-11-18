import { plainCopyForAi } from './copyEvidence';

export const COPY_FEATURE_KEYS = [
  'subject_question',
  'subject_number',
  'subject_you',
  'subject_urgency',
  'subject_social_proof',
  'subject_cta',
  'subject_emoji',
  'subject_all_caps',
  'subject_long',
  'subject_short',
  'subject_spam',
  'description_question',
  'description_bullets',
  'description_cta',
  'description_urgency',
  'description_social_proof',
  'description_guarantee',
  'description_links',
  'description_exclamation',
  'description_short',
  'description_long',
  'description_personalization',
] as const;

export type CopyFeatureKey = (typeof COPY_FEATURE_KEYS)[number];
export type CopyFeatures = Record<CopyFeatureKey, boolean>;

export const COPY_FEATURE_LABELS: Record<CopyFeatureKey, string> = {
  subject_question: 'Subject asks a question',
  subject_number: 'Subject contains a number',
  subject_you: 'Subject uses “you”',
  subject_urgency: 'Subject uses urgency',
  subject_social_proof: 'Subject uses social proof',
  subject_cta: 'Subject contains a call to action',
  subject_emoji: 'Subject contains an emoji',
  subject_all_caps: 'Subject is mostly uppercase',
  subject_long: 'Subject is longer than 80 characters',
  subject_short: 'Subject is 50 characters or fewer',
  subject_spam: 'Subject contains spam-trigger wording',
  description_question: 'Description asks a question',
  description_bullets: 'Description uses bullets or a list',
  description_cta: 'Description contains a call to action',
  description_urgency: 'Description uses urgency',
  description_social_proof: 'Description uses social proof',
  description_guarantee: 'Description contains a guarantee/absolute claim',
  description_links: 'Description contains a link',
  description_exclamation: 'Description uses exclamation marks',
  description_short: 'Description is shorter than 300 characters',
  description_long: 'Description is longer than 1,200 characters',
  description_personalization: 'Description contains a personalization token',
};

const URGENCY = /\b(now|today|tonight|tomorrow|this week|last chance|deadline|soon|limited|closing|ends?)\b/i;
const SOCIAL_PROOF = /\b(join|leaders|teams|brands|companies|experts|trusted|proven|community|peers)\b/i;
const CTA = /\b(join|register|save|reserve|book|get|claim|start|see|learn|download|watch|add)\b/i;
const SPAM = /\b(guarantee|guaranteed|100%|risk[- ]free|act now|free money|no obligation|buy now)\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

function isMostlyCaps(value: string): boolean {
  const letters = value.replace(/[^a-zA-Z]/g, '');
  return letters.length >= 10 && letters === letters.toUpperCase();
}

/**
 * Deterministic feature extraction for cross-campaign pattern analysis.
 *
 * These are observations, not judgments: a feature being present never means the copy is good or bad.
 */
export function extractCopyFeatures(copy: { summary: string; description?: string }): CopyFeatures {
  const summary = String(copy.summary || '');
  const description = plainCopyForAi(copy.description);
  const lowerSummary = summary.toLowerCase();
  const lowerDescription = description.toLowerCase();

  return {
    subject_question: /\?/.test(summary),
    subject_number: /\d/.test(summary),
    subject_you: /\byou(r)?\b/i.test(summary),
    subject_urgency: URGENCY.test(summary),
    subject_social_proof: SOCIAL_PROOF.test(summary),
    subject_cta: CTA.test(summary),
    subject_emoji: EMOJI_RE.test(summary),
    subject_all_caps: isMostlyCaps(summary),
    subject_long: summary.length > 80,
    subject_short: summary.length > 0 && summary.length <= 50,
    subject_spam: SPAM.test(summary),
    description_question: /\?/.test(description),
    description_bullets: /(^|\n)\s*(?:[-*•]|\d+[.)])\s+/.test(description) || /<li\b/i.test(String(copy.description || '')),
    description_cta: CTA.test(description),
    description_urgency: URGENCY.test(description),
    description_social_proof: SOCIAL_PROOF.test(description),
    description_guarantee: /\b(guarantee|guaranteed|100%|risk[- ]free|always works)\b/i.test(description),
    description_links: /https?:\/\/|www\./i.test(String(copy.description || '')),
    description_exclamation: /!/.test(description),
    description_short: description.length > 0 && description.length < 300,
    description_long: description.length > 1200,
    description_personalization: /\{\{|\}\}|\[[A-Z_]+\]/.test(`${summary} ${description}`) ||
      /\b(first_name|last_name|company_name)\b/i.test(`${lowerSummary} ${lowerDescription}`),
  };
}
