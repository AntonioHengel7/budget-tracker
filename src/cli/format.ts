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
 * Renders rows of string cells as a simple left-aligned, space-padded table.
 * Not fancy -- no borders, no wrapping -- just readable columns for a CLI.
 */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, i) =>
    rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), header.length),
  );

  const renderRow = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();

  return [renderRow(headers), ...rows.map((row) => renderRow(row))].join('\n');
}
