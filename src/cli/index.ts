#!/usr/bin/env node
import { Command } from 'commander';
import { formatAmount } from '../domain/money.js';

// Real commands (add/rm/list/budget/status/summary) land in a follow-up issue.
// This stub exists to prove the build + NodeNext `.js`-extension import
// convention actually resolves end-to-end at runtime, not just under vitest.
const program = new Command();

program
  .name('budget')
  .description('CLI budget tracker')
  .version('0.1.0');

program
  .command('_selftest')
  .description('internal: proves cross-module domain import resolves in the built output')
  .action(() => {
    console.log(formatAmount(1234));
  });

program.parse(process.argv);
