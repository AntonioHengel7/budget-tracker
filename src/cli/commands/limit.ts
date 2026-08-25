import { createCategoryBudget } from '../../domain/budget.js';
import type { CategoryBudget, CategoryLimitInput } from '../../domain/budget.js';
import { ValidationError } from '../../domain/errors.js';
import { parseAmount } from '../../domain/money.js';
import { updateStore } from '../../storage/jsonStore.js';

export interface SetLimitOptions {
  readonly category: string;
  readonly amount: string;
  readonly effectiveFrom: string;
  readonly rollover?: boolean;
}

/**
 * Sets (adds or supersedes) a category's spending limit, effective from a
 * given period. `rollover`, if provided, overwrites the budget's rollover
 * setting; if omitted, the existing budget's rollover setting is preserved
 * (or defaults to `false` for a brand-new budget).
 */
export async function setLimit(filePath: string, options: SetLimitOptions): Promise<CategoryBudget> {
  const amountMinor = parseAmount(options.amount);

  // Load-modify-save runs under updateStore's exclusive lock (issue #9) --
  // see add.ts for why this matters against concurrent CLI invocations.
  return updateStore(filePath, (store) => {
    const existing = store.budgets.find((budget) => budget.category === options.category.trim());
    const rollover = options.rollover ?? existing?.rollover ?? false;
    const newLimit: CategoryLimitInput = { effectiveFrom: options.effectiveFrom, amountMinor };
    // If a limit already exists for this exact effectiveFrom period, replace it
    // in place rather than appending a second entry -- resolveLimit (domain,
    // frozen) breaks ties on equal effectiveFrom by keeping the FIRST match, so
    // appending a duplicate would silently no-op the correction (and corrupt
    // carryover math for every later period, since carryover walks resolveLimit
    // repeatedly).
    const limits =
      existing === undefined
        ? [newLimit]
        : existing.limits.some((limit) => limit.effectiveFrom === options.effectiveFrom)
          ? existing.limits.map((limit) =>
              limit.effectiveFrom === options.effectiveFrom ? newLimit : limit,
            )
          : [...existing.limits, newLimit];

    const updated = createCategoryBudget({ category: options.category, rollover, limits });

    const otherBudgets = store.budgets.filter((budget) => budget.category !== updated.category);
    return { store: { ...store, budgets: [...otherBudgets, updated] }, result: updated };
  });
}

/**
 * Removes a category's entire budget (all of its dated limit entries at
 * once) from the store at `filePath`. This is whole-record removal by
 * category, mirroring `removeTransaction`'s whole-record removal by id --
 * not partial editing of a single dated entry within a category's limit
 * history (see issue #83's design decision: removing and re-adding via
 * `setLimit` is simpler and less ambiguous than identifying which single
 * dated entry to undo).
 */
export async function removeLimit(filePath: string, category: string): Promise<CategoryBudget> {
  // Load-modify-save runs under updateStore's exclusive lock (issue #9) --
  // see add.ts for why this matters against concurrent CLI invocations.
  return updateStore(filePath, (store) => {
    const trimmed = category.trim();
    const removed = store.budgets.find((budget) => budget.category === trimmed);
    if (removed === undefined) {
      throw new ValidationError(`no budget for category "${trimmed}"`);
    }

    const budgets = store.budgets.filter((budget) => budget.category !== trimmed);
    return { store: { ...store, budgets }, result: removed };
  });
}
