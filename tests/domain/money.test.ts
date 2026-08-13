import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors.js';
import { addMinor, formatAmount, parseAmount, subMinor, sumMinor } from '../../src/domain/money.js';

describe('parseAmount', () => {
  it('parses a whole number', () => {
    expect(parseAmount('12')).toBe(1200);
  });

  it('parses two decimal places', () => {
    expect(parseAmount('12.34')).toBe(1234);
  });

  it('pads a single decimal place', () => {
    expect(parseAmount('12.3')).toBe(1230);
  });

  it('parses zero', () => {
    expect(parseAmount('0')).toBe(0);
  });

  it('rejects empty input', () => {
    expect(() => parseAmount('')).toThrow(ValidationError);
    expect(() => parseAmount('   ')).toThrow(ValidationError);
  });

  it('rejects more than 2 decimal places', () => {
    expect(() => parseAmount('12.345')).toThrow(ValidationError);
  });

  it('rejects negative input', () => {
    expect(() => parseAmount('-5')).toThrow(ValidationError);
  });

  it('rejects non-numeric input', () => {
    expect(() => parseAmount('abc')).toThrow(ValidationError);
    expect(() => parseAmount('12.3.4')).toThrow(ValidationError);
    expect(() => parseAmount('NaN')).toThrow(ValidationError);
    expect(() => parseAmount('Infinity')).toThrow(ValidationError);
  });

  it('trims surrounding whitespace', () => {
    expect(parseAmount('  12.34  ')).toBe(1234);
  });
});

describe('formatAmount', () => {
  it('formats minor units back to decimal', () => {
    expect(formatAmount(1234)).toBe('12.34');
  });

  it('pads a single-digit fraction', () => {
    expect(formatAmount(1205)).toBe('12.05');
  });

  it('formats zero', () => {
    expect(formatAmount(0)).toBe('0.00');
  });

  it('rejects negative input', () => {
    expect(() => formatAmount(-1)).toThrow(ValidationError);
  });

  it('rejects non-integer input', () => {
    expect(() => formatAmount(12.5)).toThrow(ValidationError);
  });

  it('rejects non-finite input', () => {
    expect(() => formatAmount(Infinity)).toThrow(ValidationError);
    expect(() => formatAmount(NaN)).toThrow(ValidationError);
  });

  it('rejects -0', () => {
    expect(() => formatAmount(-0)).toThrow(ValidationError);
  });
});

describe('addMinor', () => {
  it('adds two amounts', () => {
    expect(addMinor(100, 200)).toBe(300);
  });

  it('rejects negative operands', () => {
    expect(() => addMinor(-1, 5)).toThrow(ValidationError);
  });

  it('throws instead of silently overflowing past MAX_SAFE_INTEGER', () => {
    expect(() => addMinor(Number.MAX_SAFE_INTEGER, 1)).toThrow(ValidationError);
  });
});

describe('subMinor', () => {
  it('subtracts two amounts', () => {
    expect(subMinor(300, 100)).toBe(200);
  });

  it('allows a negative result (overspend/carryover math)', () => {
    expect(subMinor(100, 300)).toBe(-200);
  });

  it('rejects negative operands', () => {
    expect(() => subMinor(-1, 5)).toThrow(ValidationError);
  });
});

describe('sumMinor', () => {
  it('sums a list of amounts', () => {
    expect(sumMinor([100, 200, 300])).toBe(600);
  });

  it('returns 0 for an empty list', () => {
    expect(sumMinor([])).toBe(0);
  });
});
