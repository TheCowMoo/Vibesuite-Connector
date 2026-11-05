import { describe, expect, it } from 'vitest';
import {
  crmPersonKey,
  defaultCampaignCrmNote,
  normalizeFollowUp,
  normalizeNote,
  NOTE_MAX_LENGTH,
} from '../../src/domain/campaignNotes';

describe('normalizeFollowUp', () => {
  it('accepts the four states and rejects anything else', () => {
    expect(normalizeFollowUp('none')).toBe('none');
    expect(normalizeFollowUp('todo')).toBe('todo');
    expect(normalizeFollowUp('contacted')).toBe('contacted');
    expect(normalizeFollowUp('done')).toBe('done');
    expect(normalizeFollowUp('later')).toBeNull();
    expect(normalizeFollowUp(1)).toBeNull();
  });
});

describe('normalizeNote', () => {
  it('trims text and treats a missing note as empty', () => {
    expect(normalizeNote(undefined)).toBe('');
    expect(normalizeNote('  hello  ')).toBe('hello');
  });

  it('rejects non-strings and overlong notes', () => {
    expect(normalizeNote(1)).toBeNull();
    expect(normalizeNote('x'.repeat(NOTE_MAX_LENGTH + 1))).toBeNull();
  });
});

describe('crmPersonKey', () => {
  it('uses a normalized email, then a walk-in name', () => {
    expect(crmPersonKey('Ada@Example.com', 'Ada')).toBe('ada@example.com');
    expect(crmPersonKey(undefined, '  No   Email ')).toBe('walkin:no email');
    expect(crmPersonKey('', 'Walk In')).toBe('walkin:walk in');
    expect(crmPersonKey(undefined, undefined)).toBeNull();
  });
});

describe('defaultCampaignCrmNote', () => {
  it('is an empty no-follow-up note', () => {
    expect(defaultCampaignCrmNote()).toEqual({ followUp: 'none', note: '' });
  });
});
