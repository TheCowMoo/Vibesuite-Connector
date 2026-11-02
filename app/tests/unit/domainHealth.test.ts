import { describe, it, expect } from 'vitest';
import {
  buildDomainReport,
  evaluateDkim,
  evaluateDkimSelectors,
  evaluateDmarc,
  evaluateMtaSts,
  evaluateMx,
  evaluateSpf,
  estimateSpfLookups,
  findingsFor,
  interpretDnsbl,
  overallStatus,
  type DnsblProbe,
  type DomainCheck,
} from '../../src/domain/domainHealth';

const GOOGLE_SPF = 'v=spf1 include:_spf.google.com -all';

function cleanDnsbl(): DomainCheck {
  const probes: DnsblProbe[] = [
    { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'clean' },
    { zone: 'multi.surbl.org', label: 'SURBL', status: 'clean' },
  ];
  return interpretDnsbl('example.com', probes);
}

function healthyChecks(): DomainCheck[] {
  return [
    evaluateMx([{ exchange: 'smtp.google.com', priority: 1 }]),
    evaluateSpf([GOOGLE_SPF]),
    evaluateDkim('google', ['v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A']),
    evaluateDmarc(['v=DMARC1; p=reject; rua=mailto:dmarc@example.com']),
    cleanDnsbl(),
    evaluateMtaSts([]),
  ];
}

describe('SPF', () => {
  it('fails when the record is missing', () => {
    expect(evaluateSpf([]).status).toBe('fail');
  });

  it('fails when more than one SPF record is published', () => {
    const result = evaluateSpf([GOOGLE_SPF, 'v=spf1 include:spf.protection.outlook.com -all']);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('only one is allowed');
  });

  it('passes a Google include with a hard fail', () => {
    expect(evaluateSpf([GOOGLE_SPF]).status).toBe('pass');
  });

  it('is case-insensitive about the version and include', () => {
    expect(evaluateSpf(['V=SPF1 INCLUDE:_SPF.GOOGLE.COM -ALL']).status).toBe('pass');
  });

  it('fails when Google is not authorised', () => {
    const result = evaluateSpf(['v=spf1 include:spf.protection.outlook.com -all']);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('_spf.google.com');
  });

  it('warns on ~all, ?all and +all', () => {
    expect(evaluateSpf(['v=spf1 include:_spf.google.com ~all']).status).toBe('warn');
    expect(evaluateSpf(['v=spf1 include:_spf.google.com ?all']).status).toBe('warn');
    expect(evaluateSpf(['v=spf1 include:_spf.google.com +all']).status).toBe('warn');
  });

  it('warns when there is no all mechanism at all', () => {
    expect(evaluateSpf(['v=spf1 include:_spf.google.com']).status).toBe('warn');
  });

  it('counts only lookup mechanisms', () => {
    expect(estimateSpfLookups('v=spf1 include:_spf.google.com ip4:1.2.3.4 -all')).toBe(1);
    expect(estimateSpfLookups('v=spf1 a mx include:x.test redirect=y.test -all')).toBe(4);
  });

  it('warns when the estimate goes over the ten-lookup limit', () => {
    const includes = Array.from({ length: 11 }, (_, i) => `include:spf${i}.example.com`).join(' ');
    const result = evaluateSpf([`v=spf1 include:_spf.google.com ${includes} -all`]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('12');
  });
});

describe('DMARC', () => {
  it('fails when the record is missing', () => {
    expect(evaluateDmarc([]).status).toBe('fail');
  });

  it('warns on p=none', () => {
    expect(evaluateDmarc(['v=DMARC1; p=none']).status).toBe('warn');
  });

  it('passes quarantine and reject at 100%', () => {
    expect(evaluateDmarc(['v=DMARC1; p=quarantine']).status).toBe('pass');
    expect(evaluateDmarc(['v=DMARC1; p=reject; pct=100']).status).toBe('pass');
  });

  it('warns when the policy only applies to part of the mail', () => {
    const result = evaluateDmarc(['v=DMARC1; p=quarantine; pct=25']);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('25%');
  });

  it('fails on multiple records or a missing policy', () => {
    expect(evaluateDmarc(['v=DMARC1; p=reject', 'v=DMARC1; p=none']).status).toBe('fail');
    expect(evaluateDmarc(['v=DMARC1; rua=mailto:dmarc@example.com']).status).toBe('fail');
  });

  it('reports the reporting address', () => {
    const result = evaluateDmarc(['v=DMARC1; p=reject; rua=mailto:dmarc@example.com']);
    expect(result.details.join(' ')).toContain('mailto:dmarc@example.com');
  });
});

describe('DKIM', () => {
  const key = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A';

  it('passes a published key', () => {
    expect(evaluateDkim('google', [key]).status).toBe('pass');
  });

  it('fails a revoked key (empty p=)', () => {
    const result = evaluateDkim('google', ['v=DKIM1; k=rsa; p=']);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('revoked');
  });

  it('warns when the selector has no record', () => {
    expect(evaluateDkim('google', []).status).toBe('warn');
  });

  it('accepts one usable selector among several probed', () => {
    const result = evaluateDkimSelectors([
      { selector: 'google', records: [] },
      { selector: 'custom', records: [key] },
    ]);
    expect(result.status).toBe('pass');
    expect(result.summary).toContain('custom');
    expect(result.details).toHaveLength(2);
  });

  it('fails when the only record found is revoked, even with other selectors present', () => {
    const result = evaluateDkimSelectors([
      { selector: 'google', records: [] },
      { selector: 'custom', records: ['v=DKIM1; p='] },
    ]);
    expect(result.status).toBe('fail');
  });

  it('warns when every selector is empty', () => {
    const result = evaluateDkimSelectors([
      { selector: 'google', records: [] },
      { selector: 'default', records: [] },
    ]);
    expect(result.status).toBe('warn');
    expect(result.summary).toContain('2 common selectors');
  });
});

describe('MX', () => {
  it('passes when mail servers exist', () => {
    expect(evaluateMx([{ exchange: 'smtp.google.com', priority: 1 }]).status).toBe('pass');
  });

  it('warns when there is no MX record', () => {
    expect(evaluateMx([]).status).toBe('warn');
  });

  it('warns on a null MX', () => {
    expect(evaluateMx([{ exchange: '.', priority: 0 }]).status).toBe('warn');
  });

  it('warns when a null MX is mixed with real servers', () => {
    const result = evaluateMx([
      { exchange: '.', priority: 0 },
      { exchange: 'smtp.google.com', priority: 1 },
    ]);
    expect(result.status).toBe('warn');
  });
});

describe('domain blocklists', () => {
  const clean: DnsblProbe = { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'clean' };

  it('passes when both zones are clean', () => {
    expect(cleanDnsbl().status).toBe('pass');
  });

  it('fails when the domain is listed', () => {
    const result = interpretDnsbl('example.com', [
      clean,
      { zone: 'multi.surbl.org', label: 'SURBL', status: 'listed', detail: '127.0.0.2' },
    ]);
    expect(result.status).toBe('fail');
    expect(result.summary).toContain('SURBL');
  });

  it('reports a blocked resolver as unavailable, not listed', () => {
    const result = interpretDnsbl('example.com', [
      { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'unavailable', detail: 'resolver is blocked' },
      clean,
    ]);
    expect(result.status).toBe('unavailable');
  });

  it('reports a timeout as unavailable', () => {
    const result = interpretDnsbl('example.com', [
      { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'unavailable', detail: 'DNS lookup timed out' },
      { zone: 'multi.surbl.org', label: 'SURBL', status: 'unavailable', detail: 'DNS lookup timed out' },
    ]);
    expect(result.status).toBe('unavailable');
  });

  it('a listing wins over an unavailable zone', () => {
    const result = interpretDnsbl('example.com', [
      { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'listed' },
      { zone: 'multi.surbl.org', label: 'SURBL', status: 'unavailable' },
    ]);
    expect(result.status).toBe('fail');
  });
});

describe('overall status', () => {
  it('is healthy when every required check passes', () => {
    expect(overallStatus(healthyChecks())).toBe('healthy');
  });

  it('is critical when SPF fails', () => {
    const checks = healthyChecks();
    checks[1] = evaluateSpf([]);
    expect(overallStatus(checks)).toBe('critical');
  });

  it('is critical when DMARC fails', () => {
    const checks = healthyChecks();
    checks[3] = evaluateDmarc([]);
    expect(overallStatus(checks)).toBe('critical');
  });

  it('is critical when a blocklist lists the domain', () => {
    const checks = healthyChecks();
    checks[4] = interpretDnsbl('example.com', [
      { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'listed' },
    ]);
    expect(overallStatus(checks)).toBe('critical');
  });

  it('is a warning (not critical) for missing DKIM or a soft-fail SPF', () => {
    const missingDkim = healthyChecks();
    missingDkim[2] = evaluateDkim('google', []);
    expect(overallStatus(missingDkim)).toBe('warning');

    const softSpf = healthyChecks();
    softSpf[1] = evaluateSpf(['v=spf1 include:_spf.google.com ~all']);
    expect(overallStatus(softSpf)).toBe('warning');
  });

  it('is a warning when a blocklist lookup is unavailable', () => {
    const checks = healthyChecks();
    checks[4] = interpretDnsbl('example.com', [
      { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'unavailable' },
    ]);
    expect(overallStatus(checks)).toBe('warning');
  });

  it('marks consumer domains provider-managed regardless of their records', () => {
    const checks = [evaluateSpf([]), evaluateDmarc([])];
    expect(overallStatus(checks, true)).toBe('provider_managed');
  });
});

describe('findings', () => {
  it('carries a fix for actionable failures and nothing for informational checks', () => {
    const checks = [evaluateSpf([]), evaluateDkim('google', []), evaluateMtaSts([])];
    const findings = findingsFor(checks);
    expect(findings).toHaveLength(2);
    expect(findings[0].severity).toBe('critical');
    expect(findings[0].fix).toContain('_spf.google.com');
    expect(findings[1].severity).toBe('warning');
    expect(findings[1].fix).toContain('DKIM');
  });

  it('downgrades provider-managed findings to information without a fix', () => {
    const findings = findingsFor([evaluateSpf([])], true);
    expect(findings[0].severity).toBe('info');
    expect(findings[0].fix).toBeUndefined();
  });

  it('does not suggest a DNS change when the lookup itself failed', () => {
    const unavailable = interpretDnsbl('example.com', [
      { zone: 'dbl.spamhaus.org', label: 'Spamhaus DBL', status: 'unavailable' },
    ]);
    const findings = findingsFor([unavailable]);
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].fix).toBeUndefined();
  });

  it('buildDomainReport combines the checks, status and findings', () => {
    const report = buildDomainReport({ domain: 'example.com', checks: healthyChecks() });
    expect(report.status).toBe('healthy');
    expect(report.findings).toEqual([]);
    expect(report.providerManaged).toBe(false);
  });
});
