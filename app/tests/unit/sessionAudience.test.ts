import { describe, it, expect } from 'vitest';
import { isCalendarResource, missingAudienceNote, pickInvitedEmails } from '../../src/domain/sessionAudience';

describe('pickInvitedEmails', () => {
  it('prefers the campaign recipients over every fallback', () => {
    const out = pickInvitedEmails({
      campaignEmails: ['a@x.com'],
      inviteEmails: ['b@x.com'],
      listEmails: ['c@x.com'],
    });
    expect(out).toEqual({ emails: ['a@x.com'], source: 'campaign' });
  });

  it('falls back to the invitation when the campaign has not sent yet', () => {
    const out = pickInvitedEmails({ campaignEmails: [], inviteEmails: ['b@x.com'], listEmails: ['c@x.com'] });
    expect(out).toEqual({ emails: ['b@x.com'], source: 'invite' });
  });

  it('falls back to the whole list last', () => {
    const out = pickInvitedEmails({ campaignEmails: [], inviteEmails: [], listEmails: ['c@x.com'] });
    expect(out).toEqual({ emails: ['c@x.com'], source: 'list' });
  });

  it('normalises case, trims, drops blanks and removes duplicates', () => {
    const out = pickInvitedEmails({
      campaignEmails: [' A@X.com ', 'a@x.com', '', '   ', 'not-an-email'],
      inviteEmails: [],
      listEmails: [],
    });
    expect(out.emails).toEqual(['a@x.com']);
  });

  it('reports no audience when every source is empty', () => {
    expect(pickInvitedEmails({ campaignEmails: [], inviteEmails: [], listEmails: [] }))
      .toEqual({ emails: [], source: 'none' });
  });
});

describe('isCalendarResource', () => {
  it('recognises Google resource and group calendars, case-insensitively', () => {
    expect(isCalendarResource('Room 4@resource.calendar.google.com')).toBe(true);
    expect(isCalendarResource('team@group.calendar.google.com')).toBe(true);
    expect(isCalendarResource('ada@example.com')).toBe(false);
  });
});

describe('missingAudienceNote', () => {
  it('stays silent when someone was invited', () => {
    expect(missingAudienceNote({ invitedCount: 2, seen: 1, linkedCampaigns: 0 })).toBeUndefined();
  });

  it('stays silent when nobody joined', () => {
    expect(missingAudienceNote({ invitedCount: 0, seen: 0, linkedCampaigns: 1 })).toBeUndefined();
  });

  it('explains a campaign that has not sent anything yet', () => {
    expect(missingAudienceNote({ invitedCount: 0, seen: 3, linkedCampaigns: 1 }))
      .toContain('has not sent any invitations yet');
  });

  it('explains a call with no linked audience', () => {
    expect(missingAudienceNote({ invitedCount: 0, seen: 3, linkedCampaigns: 0 }))
      .toContain('No invited list is linked');
  });
});
