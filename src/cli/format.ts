import { formatAmount } from '../domain/money.js';

export { formatAmount };

/**
 * Formats a possibly-negative minor-unit amount, e.g. a budget carry-in or
 * net balance. The domain's own `formatAmount` deliberately rejects negative
 * input (money.ts amounts are always non-negative, sign lives in `kind`),
 * but budget carryover/net balances are legitimately signed values, so this
 * formats the magnitude through `formatAmount` and re-applies the sign.
 */
export function formatSignedAmount(amountMinor: number): string {
  const normalized = Object.is(amountMinor, -0) ? 0 : amountMinor;
  return normalized < 0 ? `-${formatAmount(-normalized)}` : formatAmount(normalized);
}

/** Renders a percentage (or `null`) as a display string, e.g. `42.5%` / `n/a`. */
export function formatPercent(pct: number | null): string {
  return pct === null ? 'n/a' : `${pct.toFixed(1)}%`;
}

/**
 * Matches ASCII C0 control characters (including ESC, `\x1b`) and DEL, plus
 * the C1 control range -- i.e. every non-printable character a terminal
 * might interpret as part of an escape/control sequence. Tab and newline are
 * included since table cells are rendered as single-line, space-padded text.
 */
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * Matches Unicode bidi-control and zero-width formatting characters usable
 * for Trojan-Source-style visual spoofing: a crafted note can reorder or
 * hide rendered cell content in a terminal even though the underlying
 * codepoints never touch the C0/C1 control ranges above. Covers:
 *  - Bidi embedding/override/isolate controls: U+202A-U+202E (LRE, RLE, PDF,
 *    LRO, RLO), U+2066-U+2069 (LRI, RLI, FSI, PDI).
 *  - Bidi marks: U+200E (LRM), U+200F (RLM).
 *  - Zero-width characters: U+200B (ZWSP), U+200C (ZWNJ), U+200D (ZWJ),
 *    U+2060 (word joiner), U+FEFF (zero-width no-break space / BOM).
 */
const UNICODE_SPOOF_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/**
 * Strips terminal control characters (ESC and friends) and Unicode
 * display-spoofing characters (bidi overrides, zero-width characters) from a
 * string before it's ever written to a terminal (stdout or stderr). Values
 * sourced from the store file (e.g. `note`, `category`, transaction `id`)
 * are untrusted display data: a crafted control sequence or bidi override
 * could otherwise manipulate the terminal (move the cursor, erase lines, set
 * the window title, visually reorder/hide text, etc). This only affects what
 * gets printed -- the underlying stored value is untouched.
 *
 * Exported so every terminal-writing chokepoint can sanitize on the way
 * out, not just `formatTable`'s table cells -- error messages built from
 * store content (see `jsonStore.ts`'s `StorageError`s) flow through
 * `src/cli/index.ts`'s error handlers and need the same treatment.
 */
export function sanitizeCell(cell: string): string {
  return cell.replace(CONTROL_CHARS, '').replace(UNICODE_SPOOF_CHARS, '');
}

/**
 * Renders rows of string cells as a simple left-aligned, space-padded table.
 * Not fancy -- no borders, no wrapping -- just readable columns for a CLI.
 */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const sanitizedRows = rows.map((row) => row.map(sanitizeCell));

  const widths = headers.map((header, i) =>
    sanitizedRows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), header.length),
  );

  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();

  return [renderRow(headers), ...sanitizedRows.map((row) => renderRow(row))].join('\n');
}
