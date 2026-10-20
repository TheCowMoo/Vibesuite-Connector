import { saveCampaign } from './campaignStore';
import { getSession, saveSession } from './sessionStore';
import { planSessionZoomStamp } from './campaignZoomPlan';
import type { Campaign } from './campaign';

export { planSessionZoomStamp } from './campaignZoomPlan';

/**
 * Set (or clear) a campaign's Zoom host and keep its linked session in step.
 *
 * Both the campaign route and the OAuth callback go through this, so choosing a host in the wizard
 * and authorising one from the campaign card cannot leave the session pointing somewhere else.
 */
export async function applyCampaignZoomHost(input: {
  campaign: Campaign;
  zoomUserId?: string;
  /** The value before the change, needed to tell "campaign owns this" from "session overrode it". */
  previousZoomUserId?: string;
}): Promise<Campaign> {
  const { campaign } = input;
  const previous = input.previousZoomUserId ?? campaign.zoomUserId;

  campaign.zoomUserId = input.zoomUserId;
  await saveCampaign(campaign);

  if (!campaign.sessionId) return campaign;

  const session = await getSession(campaign.sessionId);
  if (!session) return campaign;

  const stamp = planSessionZoomStamp({
    previousCampaignHost: previous,
    nextCampaignHost: input.zoomUserId,
    sessionHost: session.zoomUserId,
  });
  if (stamp.changed) {
    session.zoomUserId = stamp.host;
    await saveSession(session);
  }

  return campaign;
}

