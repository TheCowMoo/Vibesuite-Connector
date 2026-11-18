import { percent } from './campaignStats';
import { getRecipients } from './campaignStore';
import { loadCampaignVerificationResults } from './emailVerificationLookup';
import { getCampaignVerificationAudience } from './listVerificationStore';
import { summarizeVerification, type VerificationSummary } from './emailVerificationPolicy';
import type { Campaign } from './campaign';

export interface CampaignVerificationSummary extends VerificationSummary {
  /** Percentages 0–100, one decimal. */
  rates: {
    undeliverable: number;
    catchAll: number;
    unknown: number;
    unchecked: number;
  };
}

export function verificationRates(summary: VerificationSummary): CampaignVerificationSummary['rates'] {
  return {
    undeliverable: percent(summary.undeliverable + summary.doNotSend, summary.checked),
    catchAll: percent(summary.catchAll, summary.checked),
    unknown: percent(summary.unknown, summary.checked),
    unchecked: percent(summary.unchecked, summary.total),
  };
}

/**
 * Verification summary for a campaign.
 *
 * The frozen audience list is stored with the campaign snapshot, so excluded addresses remain
 * visible in the report. Campaigns started before this feature fall back to their recipient rows.
 */
export async function collectCampaignVerification(
  camp: Campaign,
): Promise<CampaignVerificationSummary> {
  let emails = await getCampaignVerificationAudience(camp.id);
  if (!emails.length) {
    emails = (await getRecipients(camp.id)).map((recipient) => recipient.email);
  }
  const results = await loadCampaignVerificationResults(camp.id, camp.listId, emails);
  const summary = summarizeVerification(emails, results);
  return { ...summary, rates: verificationRates(summary) };
}
