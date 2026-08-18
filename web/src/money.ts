/**
 * Mirrors `src/domain/money.ts`'s `formatAmount` display convention: integer
 * minor units (e.g. cents) rendered as a decimal string, e.g. `1234` ->
 * `"12.34"`. Amounts here may be negative (e.g. a net balance) unlike the
 * domain layer's non-negative-only `amountMinor` fields, so this is a
 * display-only helper, not a re-implementation of the domain's validation.
 */
export function formatMinor(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  const whole = Math.trunc(abs / 100);
  const fraction = abs % 100;
  return `${sign}${whole}.${String(fraction).padStart(2, '0')}`;
}
