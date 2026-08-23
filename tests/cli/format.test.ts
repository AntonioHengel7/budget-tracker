import { describe, expect, it } from 'vitest';
import { formatTable, sanitizeCell } from '../../src/cli/format.js';

describe('formatTable', () => {
  it('renders a simple left-aligned, space-padded table', () => {
    const table = formatTable(['id', 'category'], [['1', 'groceries'], ['2', 'rent']]);
    expect(table).toBe(['id  category', '1   groceries', '2   rent'].join('\n'));
  });

  it('strips ESC-driven erase-line sequences from cell values before printing', () => {
    // A crafted note using CSI erase-in-line, e.g. `\x1b[2K`, could hide a
    // row in a real terminal. Once stripped, the raw ESC byte and the
    // sequence's controlling character are gone -- only inert text remains.
    const note = 'evil\x1b[2Knote';
    const table = formatTable(['id', 'note'], [['1', note]]);

    expect(table).not.toContain('\x1b');
    expect(table).toContain('evil[2Knote');
  });

  it('strips OSC set-title sequences (ESC ] ... BEL) from cell values before printing', () => {
    const note = 'evil\x1b]0;pwned\x07note';
    const table = formatTable(['id', 'note'], [['1', note]]);

    expect(table).not.toContain('\x1b');
    expect(table).not.toContain('\x07');
    expect(table).toContain('evil]0;pwnednote');
  });

  it('strips control characters from the category column too', () => {
    const category = 'rent\x1b[2K';
    const table = formatTable(['id', 'category'], [['1', category]]);

    expect(table).not.toContain('\x1b');
    expect(table).toContain('rent[2K');
  });

  it('strips a broad range of C0/C1 control characters, not just ESC', () => {
    const note = 'a\x00b\x07c\x1bd\x7fe\x9ff';
    const table = formatTable(['id', 'note'], [['1', note]]);

    expect(table).toContain('abcdef');
  });

  it('leaves ordinary printable text untouched', () => {
    const note = 'weekly shop @ 50% off!';
    const table = formatTable(['id', 'note'], [['1', note]]);

    expect(table).toContain(note);
  });

  it('strips Unicode bidi override characters used for Trojan-Source-style spoofing', () => {
    // U+202E (RLO) can flip the visual order of the text that follows it,
    // e.g. making "evil" render reversed or hiding it among reordered text.
    const note = 'evil\u202enote';
    const table = formatTable(['id', 'note'], [['1', note]]);

    expect(table).not.toContain('\u202e');
    expect(table).toContain('evilnote');
  });

  it('strips zero-width characters used to visually hide content', () => {
    // U+200B (ZWSP) is invisible when rendered but present in the string,
    // and could be used to split up or hide a flagged word from filters.
    const note = 'evi\u200bl note';
    const table = formatTable(['id', 'note'], [['1', note]]);

    expect(table).not.toContain('\u200b');
    expect(table).toContain('evil note');
  });

  // Table-driven pin of the exact character class (Socrates, PR #88 round 2
  // BLOCKING): mutation-testing the pre-fix tests showed 14 of 16 codepoints
  // (now 17, after adding U+061C below) could be silently dropped from
  // UNICODE_SPOOF_CHARS and every test would still pass. Each codepoint the
  // regex is meant to strip is asserted individually here so a future
  // narrowing of the character class fails a test immediately.
  it.each([
    ['U+061C ARABIC LETTER MARK', '\u061c'],
    ['U+200B ZERO WIDTH SPACE', '\u200b'],
    ['U+200C ZERO WIDTH NON-JOINER', '\u200c'],
    ['U+200D ZERO WIDTH JOINER', '\u200d'],
    ['U+200E LEFT-TO-RIGHT MARK', '\u200e'],
    ['U+200F RIGHT-TO-LEFT MARK', '\u200f'],
    ['U+202A LEFT-TO-RIGHT EMBEDDING', '\u202a'],
    ['U+202B RIGHT-TO-LEFT EMBEDDING', '\u202b'],
    ['U+202C POP DIRECTIONAL FORMATTING', '\u202c'],
    ['U+202D LEFT-TO-RIGHT OVERRIDE', '\u202d'],
    ['U+202E RIGHT-TO-LEFT OVERRIDE', '\u202e'],
    ['U+2060 WORD JOINER', '\u2060'],
    ['U+2061 FUNCTION APPLICATION', '\u2061'],
    ['U+2062 INVISIBLE TIMES', '\u2062'],
    ['U+2063 INVISIBLE SEPARATOR', '\u2063'],
    ['U+2064 INVISIBLE PLUS', '\u2064'],
    ['U+2066 LEFT-TO-RIGHT ISOLATE', '\u2066'],
    ['U+2067 RIGHT-TO-LEFT ISOLATE', '\u2067'],
    ['U+2068 FIRST STRONG ISOLATE', '\u2068'],
    ['U+2069 POP DIRECTIONAL ISOLATE', '\u2069'],
    ['U+FEFF ZERO WIDTH NO-BREAK SPACE / BOM', '\ufeff'],
  ])('strips %s from a cell', (_label, char) => {
    const table = formatTable(['id', 'note'], [['1', `rent${char}money`]]);

    expect(table).not.toContain(char);
    expect(table).toContain('rentmoney');
  });

  // Boundary negatives: codepoints immediately adjacent to (but outside) the
  // stripped ranges above must survive untouched, confirming the ranges are
  // exactly as wide as intended and no wider.
  it.each([
    ['U+200A HAIR SPACE (just below the U+200B-U+200F range)', '\u200a'],
    ['U+2010 HYPHEN (just above the U+200B-U+200F range)', '\u2010'],
    ['U+202F NARROW NO-BREAK SPACE (just above the U+202A-U+202E range)', '\u202f'],
    ['U+2065 unassigned (the gap between the U+2060-U+2064 and U+2066-U+2069 ranges)', '\u2065'],
    ['U+206A INHIBIT SYMMETRIC SWAPPING (just above the U+2066-U+2069 range)', '\u206a'],
  ])('does NOT strip %s from a cell', (_label, char) => {
    const table = formatTable(['id', 'note'], [['1', `rent${char}money`]]);

    expect(table).toContain(`rent${char}money`);
  });
});

describe('sanitizeCell (exported)', () => {
  // Regression (Hobbes, PR #46 round 2 BLOCKING): the fix above only
  // covered formatTable's table cells. StorageError messages built from raw
  // store content (see jsonStore.ts's validateBudget/validateStoredTransaction)
  // reach the terminal via src/cli/index.ts's two error-printing
  // chokepoints without ever passing through formatTable. sanitizeCell is
  // exported specifically so those chokepoints can reuse the same
  // stripping logic instead of only covering the table-rendering path.
  it('strips control characters from an arbitrary string, not just table cells', () => {
    const message = 'store file "x" has field "budgets[rent\x1b[2K].rollover" that is not a boolean';

    const sanitized = sanitizeCell(message);

    expect(sanitized).not.toContain('\x1b');
    expect(sanitized).toBe(
      'store file "x" has field "budgets[rent[2K].rollover" that is not a boolean',
    );
  });

  // Regression (Plato, PR #88 round 2 BLOCKING): this describe block exists
  // specifically to guard the chokepoints that call sanitizeCell directly
  // (bypassing formatTable) -- the Unicode spoofing character class added
  // above was only exercised via formatTable and had no direct-call
  // coverage here.
  it('strips Unicode bidi/zero-width spoofing characters from an arbitrary string, not just table cells', () => {
    const sanitized = sanitizeCell('rent\u202e');

    expect(sanitized).not.toContain('\u202e');
    expect(sanitized).toBe('rent');
  });
});
