import { describe, expect, it } from 'vitest';
import {
  hasResultWebhooks,
  parseResultWebhooks,
  resultWebhookFingerprint,
  webhookForSegment,
} from '../../src/domain/resultWebhooks';

describe('simple result webhooks', () => {
  it('accepts blank and valid per-result URLs', () => {
    const parsed = parseResultWebhooks({
      attended: ' https://hooks.example.com/attended ',
      partial: '',
      noShow: 'https://hooks.example.com/no-show',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      attended: 'https://hooks.example.com/attended',
      noShow: 'https://hooks.example.com/no-show',
    });
    expect(hasResultWebhooks(parsed.value)).toBe(true);
  });

  it('clears the mapping when every field is blank', () => {
    const parsed = parseResultWebhooks({ attended: '', partial: '', noShow: '', notInvited: '' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toBeUndefined();
    expect(hasResultWebhooks(parsed.value)).toBe(false);
  });

  it('rejects non-http URLs', () => {
    expect(parseResultWebhooks({ attended: 'javascript:alert(1)' }).ok).toBe(false);
    expect(parseResultWebhooks({ noShow: 'ftp://example.com/hook' }).ok).toBe(false);
  });

  it('maps each segment to its configured URL', () => {
    const webhooks = { attended: 'a', partial: 'b', noShow: 'c', notInvited: 'd' };
    expect(webhookForSegment(webhooks, 'attended')).toBe('a');
    expect(webhookForSegment(webhooks, 'partial')).toBe('b');
    expect(webhookForSegment(webhooks, 'no_show')).toBe('c');
    expect(webhookForSegment(webhooks, 'not_invited')).toBe('d');
    expect(webhookForSegment({}, 'attended')).toBeUndefined();
  });

  it('changes the dedupe key when the URL changes', () => {
    const a = resultWebhookFingerprint('ada@example.com', 'attended', 'https://a.example.com');
    const b = resultWebhookFingerprint('ada@example.com', 'attended', 'https://b.example.com');
    expect(a).not.toBe(b);
    expect(a).toContain('result-webhook');
  });
});
