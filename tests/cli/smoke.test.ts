import { execFile, execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

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

  // Regression (issue #9): two real, separate `budget add` processes
  // invoked against the same --file used to race -- both load the same
  // starting JSON, and whichever process's save wins the rename last
  // silently overwrites the other's transaction, losing it with no error.
  // This spawns real child processes (not in-process calls) so the "two
  // concurrent CLI invocations" scenario from the issue is exercised
  // exactly as described, not just simulated within a single process.
  it('two concurrent `add` invocations against the same --file both persist -- neither is silently dropped', async () => {
    const N = 8;
    const additions = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        execFileAsync('node', [
          CLI_PATH,
          '--file',
          filePath,
          'add',
          String(i + 1),
          'groceries',
          '--kind',
          'expense',
          '--date',
          '2026-08-01',
        ]),
      ),
    );

    for (const { stdout } of additions) {
      expect(stdout).toContain('added');
    }

    const stored = JSON.parse(readFileSync(filePath, 'utf-8'));
    // If the race were still present, some of the N concurrent writes would
    // clobber each other and this would be < N.
    expect(stored.transactions).toHaveLength(N);
    const amounts = stored.transactions.map((t: { transaction: { amountMinor: number } }) => t.transaction.amountMinor);
    expect(amounts.sort((a: number, b: number) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => (i + 1) * 100),
    );
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

  // Regression (Socrates, PR #46 round 3 BLOCKING): the fix at
  // src/cli/index.ts's two stderr chokepoints (run()'s catch and
  // main().catch()) had no test exercising it through the real CLI process
  // -- reverting both to a plain `console.error(message)` still left this
  // whole suite green. A StorageError message embeds raw, untrusted store
  // content (see jsonStore.ts's validateBudget), so this spawns the actual
  // built binary against a store file crafted to trigger one, and asserts
  // the real stderr bytes -- not a unit test of sanitizeCell in isolation.
  it('strips terminal control characters from an untrusted store file before printing a StorageError to stderr', () => {
    const evilCategory = 'rent\x1b[2K\x07';
    writeFileSync(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        transactions: [],
        budgets: [{ category: evilCategory, rollover: 'not-a-boolean', limits: [] }],
      }),
    );

    let stderr = '';
    try {
      execFileSync('node', [CLI_PATH, '--file', filePath, 'list'], { encoding: 'utf-8' });
      throw new Error('expected the CLI to exit non-zero on a corrupted store file');
    } catch (err) {
      stderr = (err as { stderr?: string }).stderr ?? '';
    }

    expect(stderr).toContain('rollover');
    // console.error appends its own trailing newline -- trim it before
    // checking, since that \n isn't part of the (sanitized) message text.
    expect(stderr.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  });

  // Regression (#55): the `add`/`rm`/`limit set` confirmation echoes are
  // argv-sourced (the caller's own CLI input, not store content), so they're
  // provably safe today -- but they still bypassed sanitizeCell, leaving
  // format.ts's "every terminal-writing chokepoint sanitizes on the way out"
  // docstring claim false. These pin that the fix actually strips a control
  // character and a Unicode bidi-spoof character from each of the three
  // named confirmation messages.
  describe('argv-sourced confirmation echoes are sanitized (#55)', () => {
    it('strips a control character and bidi-spoof character from the `add` confirmation', () => {
      const evilCategory = 'rent\x1b[2K‮';
      const add = runCli(['--file', filePath, 'add', '5', evilCategory, '--kind', 'expense', '--date', '2026-08-01']);

      expect(add.status).toBe(0);
      expect(add.stdout).toContain('added');
      expect(add.stdout).toContain('rent[2K');
      // console.log appends its own trailing newline -- trim before
      // checking, since that \n isn't part of the (sanitized) message text.
      expect(add.stdout.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      expect(add.stdout).not.toContain('‮');
    });

    it('strips a control character and bidi-spoof character from the `rm` confirmation', () => {
      // `rm`'s confirmation echoes back `removed.id`, which only matches
      // what's stored -- so to exercise a crafted id we write the store
      // file directly (schema only requires id to be a non-empty string,
      // see jsonStore.ts's validateStoredTransaction) rather than going
      // through `add`, whose id is internally generated and never
      // argv-controlled.
      const evilId = 'txn\x1b[2K‮1';
      writeFileSync(
        filePath,
        JSON.stringify({
          schemaVersion: 1,
          transactions: [
            {
              id: evilId,
              transaction: { date: '2026-08-01', category: 'groceries', kind: 'expense', amountMinor: 500 },
            },
          ],
          budgets: [],
        }),
      );

      const rm = runCli(['--file', filePath, 'rm', evilId]);

      expect(rm.status).toBe(0);
      expect(rm.stdout).toContain('removed txn[2K');
      expect(rm.stdout.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      expect(rm.stdout).not.toContain('‮');
    });

    it('strips a control character and bidi-spoof character from the `limit set` confirmation', () => {
      const evilCategory = 'rent\x1b[2K‮';
      const limit = runCli([
        '--file',
        filePath,
        'limit',
        'set',
        evilCategory,
        '100',
        '--effective-from',
        '2026-08',
      ]);

      expect(limit.status).toBe(0);
      expect(limit.stdout).toContain('set limit for "rent[2K');
      expect(limit.stdout.trim()).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
      expect(limit.stdout).not.toContain('‮');
    });

    // No regression test for `summary`'s "period <value>" echo: unlike the
    // three cases above, `--period` is validated by domain/period.ts's
    // parsePeriod against a strict `^\d{4}-\d{2}$` pattern *before*
    // getSummary returns, and only the untouched input is ever echoed back
    // on success -- so a control/spoof character can never actually reach
    // that console.log through real argv (it fails validation first, exit
    // 1). It's still wrapped in sanitizeCell for uniformity with the other
    // three chokepoints, but that wrap is unreachable defense-in-depth, not
    // something a real payload can exercise.
  });
});
