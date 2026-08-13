import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors.js';
import { parseIsoDate, periodOf } from '../../src/domain/date.js';

describe('parseIsoDate', () => {
  it('accepts a valid date', () => {
    expect(parseIsoDate('2026-08-12')).toBe('2026-08-12');
  });

  it('rejects 2026-02-30 (day out of range for the month)', () => {
    expect(() => parseIsoDate('2026-02-30')).toThrow(ValidationError);
  });

  it('rejects 2026-02-29 (not a leap year)', () => {
    expect(() => parseIsoDate('2026-02-29')).toThrow(ValidationError);
  });

  it('accepts 2024-02-29 (leap year)', () => {
    expect(parseIsoDate('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects 2100-02-29 (divisible by 100 but not 400 -> not a leap year)', () => {
    expect(() => parseIsoDate('2100-02-29')).toThrow(ValidationError);
  });

  it('accepts 2000-02-29 (divisible by 400 -> leap year)', () => {
    expect(parseIsoDate('2000-02-29')).toBe('2000-02-29');
  });

  it('rejects a month out of range', () => {
    expect(() => parseIsoDate('2026-13-01')).toThrow(ValidationError);
  });

  it('rejects malformed input', () => {
    expect(() => parseIsoDate('2026-8-12')).toThrow(ValidationError);
    expect(() => parseIsoDate('not-a-date')).toThrow(ValidationError);
    expect(() => parseIsoDate('')).toThrow(ValidationError);
  });
});

describe('periodOf', () => {
  it('periodOf("2026-08-12") === "2026-08"', () => {
    expect(periodOf('2026-08-12')).toBe('2026-08');
  });
});
