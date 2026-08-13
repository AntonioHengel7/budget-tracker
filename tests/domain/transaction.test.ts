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

  it('rejects an empty category', () => {
    expect(() => createTransaction({ ...validInput, category: '' })).toThrow(ValidationError);
    expect(() => createTransaction({ ...validInput, category: '   ' })).toThrow(ValidationError);
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
