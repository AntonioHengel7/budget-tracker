import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../..');
const CLI_PATH = join(REPO_ROOT, 'dist/cli/index.js');

// Mirrors src/cli/index.ts's todayIsoDate() (local time, not UTC) so this
// test can't flake around a UTC/local-time day boundary mismatch.
function localTodayIsoDate(): string {
  const now = new Date();
  const year = String(now.getFullYear()).padStart(4, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// CI's `npm run cover` step (and `npm test` locally) never runs `npm run
// build` first -- this is the one test that actually needs a real built
// dist/, so it builds it itself.
beforeAll(() => {
  execSync('npm run build', { cwd: REPO_ROOT, stdio: 'pipe' });
}, 30_000);

function runCli(args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('node', [CLI_PATH, ...args], { encoding: 'utf-8' });
    return { stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number | null };
    return { stdout: e.stdout ?? '', status: e.status ?? 1 };
  }
}

let dir: string;
let filePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-smoke-test-'));
  filePath = join(dir, 'budget.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CLI smoke test (real process invocation)', () => {
  it('add -> list -> status -> summary works end-to-end against a temp --file', () => {
    const add = runCli(['--file', filePath, 'add', '42.50', 'groceries', '--kind', 'expense', '--date', '2026-08-01']);
    expect(add.status).toBe(0);
    expect(add.stdout).toContain('added');
    expect(add.stdout).toContain('groceries');

    const limit = runCli(['--file', filePath, 'limit', 'set', 'groceries', '100', '--effective-from', '2026-08']);
    expect(limit.status).toBe(0);

    const list = runCli(['--file', filePath, 'list']);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain('groceries');
    expect(list.stdout).toContain('42.50');

    const status = runCli(['--file', filePath, 'status', '--period', '2026-08']);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('groceries');
    expect(status.stdout).toContain('under');

    const summary = runCli(['--file', filePath, 'summary', '--period', '2026-08']);
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain('expense: 42.50');

    const stored = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(stored.transactions).toHaveLength(1);
    expect(stored.budgets).toHaveLength(1);
  });

  it('exits 0 and picks up BUDGET_FILE + defaults --date/--period to today/this-month when omitted', () => {
    const today = localTodayIsoDate();

    const add = execFileSync('node', [CLI_PATH, 'add', '5', 'misc', '--kind', 'expense'], {
      encoding: 'utf-8',
      env: { ...process.env, BUDGET_FILE: filePath },
    });
    expect(add).toContain(`on ${today}`);

    const status = execFileSync('node', [CLI_PATH, 'status'], {
      encoding: 'utf-8',
      env: { ...process.env, BUDGET_FILE: filePath },
    });
    // No budgets configured yet -- proves --period defaulted without throwing.
    expect(status.trim()).toBe('no category budgets configured');

    const stored = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(stored.transactions[0].transaction.date).toBe(today);
  });

  // Regression (#12): an empty-string BUDGET_FILE ("$SOME_UNSET_VAR"
  // expanding to "") must be treated the same as unset, not as a literal
  // path -- it used to be handed straight to the store as `""` because
  // `??` doesn't catch an empty string.
  it('treats an empty BUDGET_FILE the same as unset, falling back to ./budget.json', () => {
    const add = execFileSync('node', [CLI_PATH, 'add', '5', 'misc', '--kind', 'expense'], {
      encoding: 'utf-8',
      cwd: dir,
      env: { ...process.env, BUDGET_FILE: '' },
    });
    expect(add).toContain('added');

    // Falls back to the default `./budget.json` relative to cwd, not `""`.
    const stored = JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf-8'));
    expect(stored.transactions).toHaveLength(1);
    expect(stored.transactions[0].transaction.category).toBe('misc');
  });

  // Regression (Socrates, PR #7 round 2 BLOCKING 1): the "limit set"
  // confirmation message used to print budget.limits[length - 1], assuming
  // a set always appends. Once setLimit started replacing an existing
  // limit in place (round-1 fix), correcting an earlier period printed the
  // later period's amount instead -- data on disk was right, the message
  // lied. Fixed by looking up the limit matching options.effectiveFrom.
  it('limit set prints the amount for the corrected period, not the array tail, when correcting an earlier period', () => {
    const first = runCli(['--file', filePath, 'limit', 'set', 'food', '500', '--effective-from', '2026-08']);
    expect(first.status).toBe(0);

    const second = runCli(['--file', filePath, 'limit', 'set', 'food', '700', '--effective-from', '2026-09']);
    expect(second.status).toBe(0);

    // Correcting the earlier period must not print the amount belonging to
    // the later period, which would happen if the confirmation message
    // assumed the just-set limit is always the last entry in the array.
    const correction = runCli(['--file', filePath, 'limit', 'set', 'food', '600', '--effective-from', '2026-08']);
    expect(correction.status).toBe(0);
    expect(correction.stdout).toContain('600.00');
    expect(correction.stdout).toContain('effective 2026-08');
    expect(correction.stdout).not.toContain('700.00');

    const stored = JSON.parse(readFileSync(filePath, 'utf-8'));
    expect(stored.budgets[0].limits).toEqual([
      { effectiveFrom: '2026-08', amountMinor: 60000 },
      { effectiveFrom: '2026-09', amountMinor: 70000 },
    ]);
  });

  it('exits 1 with a one-line stderr message on a handled validation error', () => {
    expect(() =>
      execFileSync('node', [CLI_PATH, '--file', filePath, 'add', '-5', 'groceries', '--kind', 'expense'], {
        encoding: 'utf-8',
      }),
    ).toThrowError(
      expect.objectContaining({
        status: 1,
        stderr: expect.stringContaining('amount must be'),
      }),
    );
  });
});
