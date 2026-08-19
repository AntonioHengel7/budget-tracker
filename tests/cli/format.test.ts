import { describe, expect, it } from 'vitest';
import { formatTable } from '../../src/cli/format.js';

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
});
