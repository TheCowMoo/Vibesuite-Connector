import { describe, it, expect } from 'vitest';
import {
  collectSendingDomainGroups,
  domainFromEmail,
  isValidDomain,
  isConsumerDomain,
  isProviderCalendarId,
  needsCalendarLookup,
  normalizeDomain,
  resolveSenderDomain,
  type SenderIdentity,
} from '../../src/domain/domainHealth';

function identity(overrides: Partial<SenderIdentity> & { connectionId: string }): SenderIdentity {
  return {
    name: overrides.connectionId,
    calendarId: 'owner@example.com',
    ...overrides,
  };
}

describe('domain normalisation', () => {
  it('lowercases, trims and strips the root dot', () => {
    expect(normalizeDomain(' Example.COM. ')).toBe('example.com');
    expect(normalizeDomain('mail.Example.co.uk')).toBe('mail.example.co.uk');
  });

  it('accepts real hostnames and rejects everything else', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('mail.example.com')).toBe(true);
    expect(isValidDomain('example.co.uk')).toBe(true);
    expect(isValidDomain('xn--bcher-kva.example')).toBe(true);

    expect(isValidDomain('localhost')).toBe(false);
    expect(isValidDomain('example')).toBe(false);
    expect(isValidDomain('-bad.example.com')).toBe(false);
    expect(isValidDomain('bad..example.com')).toBe(false);
    expect(isValidDomain('https://example.com')).toBe(false);
    expect(normalizeDomain('')).toBeUndefined();
  });

  it('reads the domain out of an email address', () => {
    expect(domainFromEmail('owner@Example.com')).toBe('example.com');
    expect(domainFromEmail('not an email')).toBeUndefined();
    expect(domainFromEmail('@example.com')).toBeUndefined();
  });

  it('knows consumer domains and provider-owned calendar ids', () => {
    expect(isConsumerDomain('gmail.com')).toBe(true);
    expect(isConsumerDomain('example.com')).toBe(false);
    expect(isProviderCalendarId('primary')).toBe(true);
    expect(isProviderCalendarId('team@group.calendar.google.com')).toBe(true);
    expect(isProviderCalendarId('owner@example.com')).toBe(false);
  });
});

describe('calendar lookup decision', () => {
  it('needs the Calendar API for primary and resource calendars', () => {
    expect(needsCalendarLookup(identity({ connectionId: 'a', calendarId: 'primary' }))).toBe(true);
    expect(
      needsCalendarLookup(identity({ connectionId: 'b', calendarId: 'room@resource.calendar.google.com' })),
    ).toBe(true);
  });

  it('does not call Google when a string already reveals the domain', () => {
    expect(needsCalendarLookup(identity({ connectionId: 'a', calendarId: 'owner@example.com' }))).toBe(false);
    expect(
      needsCalendarLookup(
        identity({
          connectionId: 'b',
          calendarId: 'opaque-calendar-id',
          subjectEmail: 'owner@example.com',
        }),
      ),
    ).toBe(false);
    expect(
      needsCalendarLookup(
        identity({
          connectionId: 'c',
          calendarId: 'primary',
          sendingDomain: 'example.com',
        }),
      ),
    ).toBe(false);
  });
});

describe('resolveSenderDomain', () => {
  it('uses the domain in an email-like calendar id', () => {
    expect(resolveSenderDomain(identity({ connectionId: 'a' }))).toEqual({
      domain: 'example.com',
      source: 'calendar',
    });
  });

  it('uses the address Google returns for a primary calendar', () => {
    expect(
      resolveSenderDomain(
        identity({
          connectionId: 'a',
          calendarId: 'primary',
          resolvedCalendarEmail: 'Owner@Example.COM',
        }),
      ),
    ).toEqual({ domain: 'example.com', source: 'calendar_lookup' });
  });

  it('leaves a primary calendar unresolved when Google cannot answer', () => {
    const result = resolveSenderDomain(identity({ connectionId: 'a', calendarId: 'primary' }));
    expect(result.domain).toBeUndefined();
    expect(result.reason).toContain('primary');
  });

  it('ignores a resource calendar even if the lookup echoes its id', () => {
    const result = resolveSenderDomain(
      identity({
        connectionId: 'a',
        calendarId: 'room@resource.calendar.google.com',
        resolvedCalendarEmail: 'room@resource.calendar.google.com',
      }),
    );
    expect(result.domain).toBeUndefined();
    expect(result.reason).toContain('shared or resource');
  });

  it('lets the per-account override win over every other source', () => {
    expect(
      resolveSenderDomain(
        identity({
          connectionId: 'a',
          calendarId: 'owner@wrong.example',
          subjectEmail: 'owner@other.example',
          sendingDomain: 'Sending.Example.COM.',
        }),
      ),
    ).toEqual({ domain: 'sending.example.com', source: 'profile' });
  });

  it('ignores an invalid override and falls back to the calendar', () => {
    expect(
      resolveSenderDomain(
        identity({ connectionId: 'a', sendingDomain: 'not a domain', calendarId: 'owner@example.com' }),
      ),
    ).toEqual({ domain: 'example.com', source: 'calendar' });
  });

  it('prefers the service-account subject over an opaque calendar id', () => {
    expect(
      resolveSenderDomain(
        identity({
          connectionId: 'a',
          calendarId: 'opaque-id',
          subjectEmail: 'sender@workspace.example',
        }),
      ),
    ).toEqual({ domain: 'workspace.example', source: 'subject' });
  });
});

describe('collectSendingDomainGroups', () => {
  it('dedupes accounts on the same domain', () => {
    const { domains } = collectSendingDomainGroups([
      identity({ connectionId: 'a', name: 'Maya', calendarId: 'maya@example.com' }),
      identity({ connectionId: 'b', name: 'Theo', calendarId: 'theo@example.com' }),
    ]);

    expect(domains).toHaveLength(1);
    expect(domains[0].domain).toBe('example.com');
    expect(domains[0].accounts.map((a) => a.connectionId)).toEqual(['a', 'b']);
  });

  it('marks gmail.com provider-managed but still groups it', () => {
    const { domains } = collectSendingDomainGroups([
      identity({ connectionId: 'a', calendarId: 'maya@gmail.com' }),
    ]);
    expect(domains[0].providerManaged).toBe(true);
  });

  it('keeps unresolved accounts out of the domain list and explains why', () => {
    const { domains, unresolved } = collectSendingDomainGroups([
      identity({ connectionId: 'a', name: 'Primary', calendarId: 'primary' }),
      identity({ connectionId: 'b', name: 'Room', calendarId: 'room@resource.calendar.google.com' }),
      identity({ connectionId: 'c', name: 'Known', calendarId: 'owner@example.com' }),
    ]);

    expect(domains).toHaveLength(1);
    expect(unresolved).toHaveLength(2);
    expect(unresolved.map((u) => u.name)).toEqual(['Primary', 'Room']);
    expect(unresolved[0].reason).toContain('primary');
  });

  it('collects selectors per domain for the DKIM probe', () => {
    const { domains } = collectSendingDomainGroups([
      identity({ connectionId: 'a', calendarId: 'maya@example.com', dkimSelector: 'Google' }),
      identity({ connectionId: 'b', calendarId: 'theo@example.com', dkimSelector: 'custom' }),
    ]);
    expect(domains[0].selectors).toEqual(['google', 'custom']);
  });
});
