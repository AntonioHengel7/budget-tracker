import { createCategoryBudget } from '../../domain/budget.js';
import type { CategoryBudget, CategoryLimitInput } from '../../domain/budget.js';
import { parseAmount } from '../../domain/money.js';
import { loadStore, saveStore } from '../../storage/jsonStore.js';

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
  const store = await loadStore(filePath);

  const existing = store.budgets.find((budget) => budget.category === options.category.trim());
  const rollover = options.rollover ?? existing?.rollover ?? false;
  const newLimit: CategoryLimitInput = { effectiveFrom: options.effectiveFrom, amountMinor };
  const limits = existing === undefined ? [newLimit] : [...existing.limits, newLimit];

  const updated = createCategoryBudget({ category: options.category, rollover, limits });

  const otherBudgets = store.budgets.filter((budget) => budget.category !== updated.category);
  await saveStore(filePath, { ...store, budgets: [...otherBudgets, updated] });

  return updated;
}
