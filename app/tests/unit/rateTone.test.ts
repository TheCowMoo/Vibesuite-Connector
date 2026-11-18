import { describe, expect, it } from 'vitest';
import rateTone from '../../public/rateTone.js';

const { classify, format } = rateTone;

describe('Yes-rate KPI bands', () => {
  it('is green only above the 70% KPI', () => {
    expect(classify(70.1, true).tone).toBe('success');
    expect(classify(100, true).tone).toBe('success');
    expect(classify(70, true)).toEqual({ tone: 'warning', label: 'Watch' });
    expect(classify(50, true).tone).toBe('warning');
    expect(classify(49.9, true).tone).toBe('danger');
    expect(classify(0, true).tone).toBe('danger');
  });

  it('stays neutral when there are no yes or maybe replies', () => {
    expect(classify(0, false)).toEqual({ tone: 'neutral', label: 'No replies' });
    expect(classify(80, false).tone).toBe('neutral');
    expect(classify(NaN, true).tone).toBe('neutral');
  });

  it('formats one decimal and uses an em dash for no data', () => {
    expect(format(71.43, true)).toBe('71.4%');
    expect(format(70, true)).toBe('70%');
    expect(format(0, true)).toBe('0%');
    expect(format(0, false)).toBe('—');
  });
});
