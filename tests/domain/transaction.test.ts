import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/domain/errors.js';
import { createTransaction } from '../../src/domain/transaction.js';

const validInput = {
  date: '2026-08-12',
  category: 'groceries',
  kind: 'expense',
  amountMinor: 1500,
};

describe('createTransaction', () => {
  it('creates a valid transaction', () => {
    const tx = createTransaction(validInput);
    expect(tx).toEqual({
      date: '2026-08-12',
      category: 'groceries',
      kind: 'expense',
      amountMinor: 1500,
    });
  });

  it('rejects amountMinor <= 0', () => {
    expect(() => createTransaction({ ...validInput, amountMinor: 0 })).toThrow(ValidationError);
    expect(() => createTransaction({ ...validInput, amountMinor: -100 })).toThrow(ValidationError);
  });

  it('rejects non-integer amountMinor', () => {
    expect(() => createTransaction({ ...validInput, amountMinor: 12.5 })).toThrow(ValidationError);
  });

  // Regression (Hobbes, PR #4 BLOCKING 2): Number.isInteger(1e300) is true,
  // so the old `!Number.isInteger(x) || x <= 0` check let unsafe-integer
  // amounts through. amountMinor must now be routed through money.ts's
  // assertSafeNonNegativeInteger, matching the exact bar money.ts itself
  // enforces for every other amount in the domain layer.
  it('rejects an amountMinor beyond the safe integer range (e.g. 1e300)', () => {
    expect(() => createTransaction({ ...validInput, amountMinor: 1e300 })).toThrow(ValidationError);
  });

  it('rejects an empty category', () => {
    expect(() => createTransaction({ ...validInput, category: '' })).toThrow(ValidationError);
    expect(() => createTransaction({ ...validInput, category: '   ' })).toThrow(ValidationError);
  });

  it('rejects a category over 100 characters', () => {
    const category = 'a'.repeat(101);
    expect(() => createTransaction({ ...validInput, category })).toThrow(ValidationError);
  });

  it('accepts a category of exactly 100 characters', () => {
    const category = 'a'.repeat(100);
    const tx = createTransaction({ ...validInput, category });
    expect(tx.category).toBe(category);
  });

  // Trimming happens before the length check, so surrounding whitespace
  // doesn't count against the limit.
  it('accepts a category that is exactly 100 characters after trimming', () => {
    const category = `  ${'a'.repeat(100)}  `;
    const tx = createTransaction({ ...validInput, category });
    expect(tx.category).toBe('a'.repeat(100));
  });

  it('rejects an unknown kind', () => {
    expect(() => createTransaction({ ...validInput, kind: 'transfer' })).toThrow(ValidationError);
  });

  it('trims the note', () => {
    const tx = createTransaction({ ...validInput, note: '  lunch with friends  ' });
    expect(tx.note).toBe('lunch with friends');
  });

  it('omits note entirely when not provided', () => {
    const tx = createTransaction(validInput);
    expect('note' in tx).toBe(false);
  });

  it('rejects a note over 200 characters', () => {
    const note = 'a'.repeat(201);
    expect(() => createTransaction({ ...validInput, note })).toThrow(ValidationError);
  });

  it('accepts a note of exactly 200 characters', () => {
    const note = 'a'.repeat(200);
    const tx = createTransaction({ ...validInput, note });
    expect(tx.note).toBe(note);
  });

  it('rejects an invalid date', () => {
    expect(() => createTransaction({ ...validInput, date: '2026-02-30' })).toThrow(ValidationError);
  });
});
