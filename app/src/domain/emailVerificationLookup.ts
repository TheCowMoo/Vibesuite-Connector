import {
  getCachedEmailVerifications,
  normalizeVerificationEmail,
  type StoredEmailVerification,
} from './emailVerificationStore';
import {
  getCampaignVerificationResults,
  getListVerificationResults,
  saveCampaignVerificationAudience,
  saveCampaignVerificationResults,
} from './listVerificationStore';

function uniqueEmails(emails: string[]): string[] {
  return Array.from(new Set(emails.map(normalizeVerificationEmail).filter(Boolean)));
}

function mergeResults(
  base: Map<string, StoredEmailVerification>,
  overlay: Map<string, StoredEmailVerification>,
): Map<string, StoredEmailVerification> {
  const out = new Map(base);
  for (const [email, result] of overlay) out.set(normalizeVerificationEmail(email), result);
  return out;
}

/** List snapshot wins over the global cache, then the cache fills any gaps. */
export async function loadListVerificationResults(
  listId: string,
  emails: string[],
): Promise<Map<string, StoredEmailVerification>> {
  const unique = uniqueEmails(emails);
  if (!unique.length) return new Map();
  const [stored, cached] = await Promise.all([
    getListVerificationResults(listId, unique),
    getCachedEmailVerifications(unique),
  ]);
  return mergeResults(cached, stored);
}

/** Freeze the audience's verification results onto the campaign. */
export async function snapshotCampaignVerification(
  campaignId: string,
  listId: string,
  emails: string[],
): Promise<Map<string, StoredEmailVerification>> {
  await saveCampaignVerificationAudience(campaignId, emails);
  const results = await loadListVerificationResults(listId, emails);
  if (results.size) await saveCampaignVerificationResults(campaignId, Array.from(results.values()));
  return results;
}

/** Campaign snapshot wins; for older campaigns fall back to the list/cache. */
export async function loadCampaignVerificationResults(
  campaignId: string,
  listId: string,
  emails: string[],
): Promise<Map<string, StoredEmailVerification>> {
  const unique = uniqueEmails(emails);
  if (!unique.length) return new Map();
  const [snapshot, list] = await Promise.all([
    getCampaignVerificationResults(campaignId, unique),
    loadListVerificationResults(listId, unique),
  ]);
  return mergeResults(list, snapshot);
}
