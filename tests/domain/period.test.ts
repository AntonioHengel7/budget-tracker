import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors.js';
import { comparePeriod, nextPeriod, parsePeriod, periodsBetween } from '../../src/domain/period.js';

describe('parsePeriod', () => {
  it('accepts a valid period', () => {
    expect(parsePeriod('2026-08')).toBe('2026-08');
  });

  it('rejects "2026-13"', () => {
    expect(() => parsePeriod('2026-13')).toThrow(ValidationError);
  });

  it('rejects "2026-00"', () => {
    expect(() => parsePeriod('2026-00')).toThrow(ValidationError);
  });

  it('rejects "2026-1" (not zero-padded)', () => {
    expect(() => parsePeriod('2026-1')).toThrow(ValidationError);
  });

  it('rejects ""', () => {
    expect(() => parsePeriod('')).toThrow(ValidationError);
  });
});

describe('nextPeriod', () => {
  it('rolls 2026-12 -> 2027-01', () => {
    expect(nextPeriod('2026-12')).toBe('2027-01');
  });

  it('increments within the same year', () => {
    expect(nextPeriod('2026-01')).toBe('2026-02');
  });

  // Regression (Hobbes, PR #4 BLOCKING 1): nextPeriod("9999-12") used to
  // return "10000-01", a 5-digit year that breaks the zero-padded-string-
  // compare invariant and sent periodsBetween into an unbounded loop.
  it('rejects rolling past year 9999 instead of producing a 5-digit year', () => {
    expect(() => nextPeriod('9999-12')).toThrow(ValidationError);
  });

  it('rolls within year 9999 normally', () => {
    expect(nextPeriod('9999-11')).toBe('9999-12');
  });
});

describe('comparePeriod', () => {
  it('orders chronologically', () => {
    expect(comparePeriod('2026-01', '2026-02')).toBeLessThan(0);
    expect(comparePeriod('2026-02', '2026-01')).toBeGreaterThan(0);
    expect(comparePeriod('2026-01', '2026-01')).toBe(0);
    expect(comparePeriod('2025-12', '2026-01')).toBeLessThan(0);
  });
});

describe('periodsBetween', () => {
  it('is inclusive of both ends', () => {
    expect(periodsBetween('2026-01', '2026-03')).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('returns a single-element array when from === to', () => {
    expect(periodsBetween('2026-05', '2026-05')).toEqual(['2026-05']);
  });

  it('returns [] when to < from', () => {
    expect(periodsBetween('2026-05', '2026-01')).toEqual([]);
  });

  it('rolls across a year boundary', () => {
    expect(periodsBetween('2026-11', '2027-02')).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
    ]);
  });

  // Regression (Hobbes, PR #4 BLOCKING 1): periodsBetween(..., "9999-12")
  // used to never terminate -- it kept calling nextPeriod past the year-9999
  // boundary, misordering via the broken 5-digit-year string and looping
  // forever while pushing into `result` (OOM). It must now terminate
  // immediately once it reaches "to", without ever calling nextPeriod again.
  it('terminates at the year-9999 boundary instead of looping forever', () => {
    expect(periodsBetween('9999-10', '9999-12')).toEqual(['9999-10', '9999-11', '9999-12']);
  });

  // Regression (Hobbes, PR #4 BLOCKING 1): defensive cap, independent of
  // nextPeriod's own bound -- an absurdly large requested range must fail
  // fast with a ValidationError rather than accumulate unbounded memory.
  it('throws instead of accumulating an unbounded number of periods', () => {
    expect(() => periodsBetween('0001-01', '9999-12')).toThrow(ValidationError);
  });
});
