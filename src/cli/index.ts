#!/usr/bin/env node
import { Command } from 'commander';
import { addTransaction } from './commands/add.js';
import { removeTransaction } from './commands/rm.js';
import { listTransactions } from './commands/list.js';
import { setLimit } from './commands/limit.js';
import { getStatus } from './commands/status.js';
import { getSummary } from './commands/summary.js';
import { formatAmount, formatPercent, formatSignedAmount, formatTable } from './format.js';

/**
 * `new Date()` is used only here, in the CLI wiring layer -- never inside
 * src/domain/**. Defaults are computed once per invocation and formatted
 * into the domain's IsoDate/Period string shapes before crossing the
 * handler boundary.
 */
function todayIsoDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function currentPeriod(): string {
  return todayIsoDate().slice(0, 7);
}

const program = new Command();

program
  .name('budget')
  .description('CLI budget tracker')
  .version('0.1.0')
  .option('-f, --file <path>', 'path to the budget JSON store file');

/** Resolves the store path: --file > BUDGET_FILE env var > ./budget.json. */
function resolveFilePath(): string {
  const opts = program.opts<{ file?: string }>();
  return opts.file ?? process.env.BUDGET_FILE ?? './budget.json';
}

/**
 * Thin wrapper shared by every command: runs `fn`, and on any thrown error
 * prints a one-line message to stderr and sets exit code 1. Success paths
 * are responsible for their own stdout output and leave exit code 0.
 */
async function run(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exitCode = 1;
  }
}

interface AddCliOptions {
  readonly kind: string;
  readonly date?: string;
  readonly note?: string;
}

program
  .command('add <amount> <category>')
  .description('Add a transaction')
  .requiredOption('--kind <kind>', 'income or expense')
  .option('--date <date>', 'ISO date YYYY-MM-DD, defaults to today')
  .option('--note <note>', 'optional note')
  .action(async (amount: string, category: string, options: AddCliOptions) => {
    await run(async () => {
      const filePath = resolveFilePath();
      const date = options.date ?? todayIsoDate();
      const result = await addTransaction(filePath, { ...options, amount, category, date });
      console.log(
        `added ${result.id} (${result.transaction.kind} ${formatAmount(result.transaction.amountMinor)} ${result.transaction.category} on ${result.transaction.date})`,
      );
    });
  });

program
  .command('rm <id>')
  .description('Remove a transaction by id')
  .action(async (id: string) => {
    await run(async () => {
      const filePath = resolveFilePath();
      const removed = await removeTransaction(filePath, id);
      console.log(`removed ${removed.id}`);
    });
  });

interface ListCliOptions {
  readonly from?: string;
  readonly to?: string;
  readonly category?: string;
  readonly kind?: string;
  readonly note?: string;
}

program
  .command('list')
  .description('List transactions')
  .option('--from <date>', 'ISO date, inclusive lower bound')
  .option('--to <date>', 'ISO date, inclusive upper bound')
  .option('--category <category>', 'exact category match')
  .option('--kind <kind>', 'income or expense')
  .option('--note <text>', 'note substring, case-insensitive')
  .action(async (options: ListCliOptions) => {
    await run(async () => {
      const filePath = resolveFilePath();
      const results = await listTransactions(filePath, options);
      if (results.length === 0) {
        console.log('no transactions found');
        return;
      }
      const rows = results.map((st) => [
        st.id,
        st.transaction.date,
        st.transaction.kind,
        st.transaction.category,
        formatAmount(st.transaction.amountMinor),
        st.transaction.note ?? '',
      ]);
      console.log(formatTable(['id', 'date', 'kind', 'category', 'amount', 'note'], rows));
    });
  });

interface LimitSetCliOptions {
  readonly effectiveFrom: string;
  readonly rollover?: boolean;
}

const limitCommand = program.command('limit').description('Manage category budget limits');

limitCommand
  .command('set <category> <amount>')
  .description('Add or supersede a category limit')
  .requiredOption('--effective-from <period>', 'YYYY-MM period this limit takes effect from')
  .option('--rollover', 'roll unspent/overspent balance into the next period')
  .action(async (category: string, amount: string, options: LimitSetCliOptions) => {
    await run(async () => {
      const filePath = resolveFilePath();
      const budget = await setLimit(filePath, { ...options, category, amount });
      const matched = budget.limits.find((limit) => limit.effectiveFrom === options.effectiveFrom);
      console.log(
        `set limit for "${budget.category}": ${matched ? formatAmount(matched.amountMinor) : 'n/a'} effective ${options.effectiveFrom} (rollover: ${budget.rollover})`,
      );
    });
  });

interface StatusCliOptions {
  readonly period?: string;
}

program
  .command('status')
  .description('Show budget status for a period')
  .option('--period <period>', 'YYYY-MM period, defaults to the current month')
  .action(async (options: StatusCliOptions) => {
    await run(async () => {
      const filePath = resolveFilePath();
      const period = options.period ?? currentPeriod();
      const results = await getStatus(filePath, { period });
      if (results.length === 0) {
        console.log('no category budgets configured');
        return;
      }
      const rows = results.map((s) => [
        s.category,
        formatSignedAmount(s.limitMinor),
        formatSignedAmount(s.carryInMinor),
        formatSignedAmount(s.availableMinor),
        formatSignedAmount(s.spentMinor),
        s.state,
        formatPercent(s.pctUsed),
      ]);
      console.log(
        formatTable(['category', 'limit', 'carry', 'available', 'spent', 'state', 'pctUsed'], rows),
      );
    });
  });

interface SummaryCliOptions {
  readonly period?: string;
}

program
  .command('summary')
  .description('Show income/expense summary for a period')
  .option('--period <period>', 'YYYY-MM period, defaults to the current month')
  .action(async (options: SummaryCliOptions) => {
    await run(async () => {
      const filePath = resolveFilePath();
      const period = options.period ?? currentPeriod();
      const result = await getSummary(filePath, { period });
      console.log(`period ${result.period.period}`);
      console.log(`income:  ${formatAmount(result.period.incomeMinor)}`);
      console.log(`expense: ${formatAmount(result.period.expenseMinor)}`);
      console.log(`net:     ${formatSignedAmount(result.period.netMinor)}`);
      if (result.byCategory.length > 0) {
        const rows = result.byCategory.map((c) => [c.category, formatAmount(c.spentMinor)]);
        console.log(formatTable(['category', 'spent'], rows));
      }
    });
  });

async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
