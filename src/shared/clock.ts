/**
 * `new Date()` is used only here, in the wiring layer -- never inside
 * src/domain/**. Defaults are computed once per invocation and formatted
 * into the domain's IsoDate/Period string shapes before crossing the
 * handler boundary.
 *
 * Extracted from src/cli/index.ts so the server (src/server/**) can default
 * `date`/`period` the same way the CLI does, without duplicating this logic.
 */
export function todayIsoDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function currentPeriod(): string {
  return todayIsoDate().slice(0, 7);
}
