import type { GoogleResponseStatus } from '../google/types';

export type GhlWebhookBranch = 'confirmed' | 'tentative' | 'declined' | null;

export interface GhlAction {
  rsvp: 'accepted' | 'tentative' | 'declined' | 'needsAction';
  appointmentStatus: 'confirmed' | 'cancelled' | 'tentative' | 'pending';
  tagsToAdd: string[];
  tagsToRemove: string[];
  setDnd: boolean;
  webhookBranch: GhlWebhookBranch;
}

export function toGhlAction(responseStatus: GoogleResponseStatus | string): GhlAction {
  switch (responseStatus) {
    case 'accepted':
      return {
        rsvp: 'accepted',
        appointmentStatus: 'confirmed',
        tagsToAdd: ['rsvp-yes'],
        tagsToRemove: ['rsvp-no', 'rsvp-maybe', 'rsvp-pending'],
        setDnd: false,
        webhookBranch: 'confirmed',
      };
    case 'tentative':
      return {
        rsvp: 'tentative',
        appointmentStatus: 'tentative',
        tagsToAdd: ['rsvp-maybe'],
        tagsToRemove: ['rsvp-no', 'rsvp-yes', 'rsvp-pending'],
        setDnd: false,
        webhookBranch: 'tentative',
      };
    case 'declined':
      return {
        rsvp: 'declined',
        appointmentStatus: 'cancelled',
        tagsToAdd: ['rsvp-no', 'communication-stopped'],
        tagsToRemove: ['rsvp-yes', 'rsvp-maybe', 'rsvp-pending'],
        setDnd: true,
        webhookBranch: 'declined',
      };
    case 'needsAction':
    default:
      return {
        rsvp: 'needsAction',
        appointmentStatus: 'pending',
        tagsToAdd: ['rsvp-pending'],
        tagsToRemove: ['rsvp-yes', 'rsvp-no', 'rsvp-maybe'],
        setDnd: false,
        webhookBranch: null,
      };
  }
}
