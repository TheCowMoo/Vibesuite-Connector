import type { Campaign } from './campaign';
import { campaignVariants } from './campaignVariants';
import { percent, type CampaignFunnel, type CampaignStats } from './campaignStats';

export type CopyObjective = 'balanced' | 'replies' | 'show_up';
export type CopySuggestionMode = 'improve' | 'challenger' | 'both';
export type CopySampleLabel = 'none' | 'small' | 'directional' | 'larger';

export interface CopyAggregateEvidence {
  sent: number;
  failed: number;
  accepted: number;
  tentative: number;
  declined: number;
  noResponse: number;
  attended: number;
  noShow: number;
  acceptanceRate: number;
  yesRate: number;
  showUpRate: number;
  attendedPerSent: number;
}

export interface CopyVariantEvidence extends CopyAggregateEvidence {
  id: string;
  summary: string;
  description: string;
  sampleLabel: CopySampleLabel;
  hasAttendance: boolean;
}

export interface CopyEvidence {
  objective: CopyObjective;
  hasAttendance: boolean;
  aggregate: CopyAggregateEvidence;
  variants: CopyVariantEvidence[];
  /** Plain-language caveats the AI must see and the UI can show. */
  dataQuality: string[];
  generatedAt: number;
}

function emptyFunnel(): CampaignFunnel {
  return {
    invited: 0,
    queued: 0,
    sent: 0,
    failed: 0,
    accepted: 0,
    declined: 0,
    tentative: 0,
    noResponse: 0,
    attended: 0,
    noShow: 0,
    failedRate: 0,
    rsvpRate: 0,
    acceptanceRate: 0,
    responseRate: 0,
    attendanceRate: 0,
  };
}

/** Turn stored rich copy into plain text and remove URLs before anything reaches an AI provider. */
export function plainCopyForAi(value: string | undefined): string {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/https?:\/\/\S+/gi, '[link removed]')
    .replace(/\bwww\.\S+/gi, '[link removed]')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function evidenceFromFunnel(funnel: CampaignFunnel): CopyAggregateEvidence {
  const expected = funnel.accepted + funnel.tentative;
  return {
    sent: funnel.sent,
    failed: funnel.failed,
    accepted: funnel.accepted,
    tentative: funnel.tentative,
    declined: funnel.declined,
    noResponse: funnel.noResponse,
    attended: funnel.attended,
    noShow: funnel.noShow,
    acceptanceRate: percent(funnel.accepted, funnel.sent),
    yesRate: percent(funnel.accepted, expected),
    showUpRate: percent(funnel.attended, expected),
    attendedPerSent: percent(funnel.attended, funnel.sent),
  };
}

function sampleLabel(sent: number): CopySampleLabel {
  if (!sent) return 'none';
  // Descriptive labels only. Nothing is blocked by these thresholds.
  if (sent < 30) return 'small';
  if (sent < 100) return 'directional';
  return 'larger';
}

function addDataQuality(notes: string[], evidence: CopyEvidence, copies: ReturnType<typeof campaignVariants>): void {
  if (!evidence.hasAttendance) {
    notes.push('Zoom attendance has not been synced for this campaign. Show-up is not measured, not zero.');
  } else {
    notes.push('Brief Zoom visits currently count as attended; full and partial attendance are not separated here.');
  }

  const failed = evidence.aggregate.failed;
  if (failed > 0) {
    notes.push(`${failed} attempted send${failed === 1 ? '' : 's'} failed, so the copy results may be biased by delivery/sending problems.`);
  }

  const small = evidence.variants.filter((v) => v.sent > 0 && v.sent < 30);
  if (small.length) {
    notes.push(`Some variants have small samples (${small.map((v) => `${v.id}: n=${v.sent}`).join(', ')}); treat differences as directional.`);
  }

  if (evidence.variants.some((v) => v.sent === 0)) {
    notes.push('At least one variant has no sends yet, so it has no performance evidence.');
  }

  if (copies.length > 1) {
    const subjectChanged = new Set(copies.map((v) => v.summary.trim().toLowerCase())).size > 1;
    const descriptionChanged = new Set(copies.map((v) => plainCopyForAi(v.description).toLowerCase())).size > 1;
    const linkChanged = new Set(copies.map((v) => String(v.registrationUrl || ''))).size > 1;
    if ([subjectChanged, descriptionChanged, linkChanged].filter(Boolean).length > 1) {
      notes.push('Variants differ in more than one element (subject, description or registration link), so this is not a controlled one-variable test.');
    }
  }
}

/**
 * Build the evidence scorecard for Copy Coach.
 *
 * Campaign stats already attribute RSVP and Zoom attendance by variant. This adds the copy itself
 * and the sample/quality caveats; it never includes recipient-level data.
 */
export function buildCopyEvidence(
  camp: Campaign,
  stats: CampaignStats,
  objective: CopyObjective,
  now = Date.now(),
): CopyEvidence {
  const copies = campaignVariants(camp);
  const byVariant = new Map(stats.variants.map((row) => [row.variant, row]));

  const variants: CopyVariantEvidence[] = copies.map((copy) => {
    const funnel = byVariant.get(copy.id) ?? emptyFunnel();
    return {
      id: copy.id,
      summary: copy.summary,
      description: plainCopyForAi(copy.description),
      ...evidenceFromFunnel(funnel),
      sampleLabel: sampleLabel(funnel.sent),
      hasAttendance: stats.hasAttendance,
    };
  });

  const evidence: CopyEvidence = {
    objective,
    hasAttendance: stats.hasAttendance,
    aggregate: evidenceFromFunnel(stats.funnel),
    variants,
    dataQuality: [],
    generatedAt: now,
  };
  addDataQuality(evidence.dataQuality, evidence, copies);
  return evidence;
}
