import { randomUUID } from 'node:crypto';
import { link, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StorageError } from '../storage/jsonStore.js';
import { verifyPassword } from './credentials.js';
import { resolveSignupPath } from './paths.js';
import type { SignupRecord } from './signupSchema.js';

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Reads and JSON-parses the signup record at `filePath`. `null` on a missing
 * file (ENOENT); any other read/parse failure is wrapped in a `StorageError`
 * -- a corrupted signup record is treated the same as a corrupted budget
 * store file elsewhere in this app (fail loud, never silently ignore it).
 */
async function readSignupFile(filePath: string): Promise<SignupRecord | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return null;
    }
    throw new StorageError(`failed to read signup record "${filePath}": ${(err as Error).message}`, {
      cause: err,
    });
  }

  try {
    return JSON.parse(raw) as SignupRecord;
  } catch (err) {
    throw new StorageError(`signup record "${filePath}" contains invalid JSON`, { cause: err });
  }
}

/**
 * Lists the `.json` signup record filenames in `signupsDir`. A missing
 * directory (ENOENT) -- the normal state before any signup has ever
 * happened -- returns an empty list rather than throwing; any other listing
 * failure is a genuine `StorageError`. Shared by the two directory-scan
 * lookups below (`findSignupByUsernameCaseFold`/`findSignupByEmail`); the
 * sweep below does not use this helper -- see its own doc comment for why.
 */
async function listSignupFilenames(signupsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(signupsDir);
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') {
      return [];
    }
    throw new StorageError(
      `failed to list signups directory "${signupsDir}": ${(err as Error).message}`,
      { cause: err },
    );
  }
  return entries.filter((entry) => entry.endsWith('.json'));
}

/** Reads a signup record by exact, case-sensitive username. `null` if none exists. */
export async function readSignup(signupsDir: string, username: string): Promise<SignupRecord | null> {
  return readSignupFile(resolveSignupPath(signupsDir, username));
}

/**
 * Creates a brand-new signup record at `<signupsDir>/<record.username>.json`,
 * truly atomically and exclusively: the record is first written to a
 * uniquely-named temp file in the same directory, then `link()`ed onto the
 * final path. `link()` -- not `rename()` -- is the load-bearing choice here:
 * POSIX guarantees `link()` fails with `EEXIST` if the target already exists,
 * which is exactly the "create only if absent" guarantee this needs.
 * `rename()` has no such guarantee -- it silently clobbers whatever is
 * already at the target, which would let a second concurrent signup for the
 * same username overwrite (and lose) the first one's record.
 *
 * The temp file is always cleaned up (`finally`), whether the link succeeds,
 * loses the race (`EEXIST`), or fails for any other reason -- otherwise a
 * stray `.tmp` file would leak into `signupsDir` on every single call.
 */
export async function createSignupExclusive(
  signupsDir: string,
  record: SignupRecord,
): Promise<'created' | 'exists'> {
  await mkdir(signupsDir, { recursive: true, mode: 0o700 });
  const finalPath = resolveSignupPath(signupsDir, record.username);
  const tempPath = join(signupsDir, `.${record.username}.${randomUUID()}.tmp`);
  const json = JSON.stringify(record, null, 2);

  try {
    await writeFile(tempPath, json, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new StorageError(
      `failed to write signup record for "${record.username}": ${(err as Error).message}`,
      { cause: err },
    );
  }

  try {
    await link(tempPath, finalPath);
    return 'created';
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EEXIST') {
      return 'exists';
    }
    throw new StorageError(
      `failed to create signup record for "${record.username}": ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Overwrites (or creates) the signup record at `<signupsDir>/<record.username>.json`
 * -- no exclusivity guarantee, unlike `createSignupExclusive`. Used for the
 * two cases where clobbering the existing record on disk is exactly the
 * intent: flipping `verified` from false to true on a successful
 * verification, and the same-username resend/retry path in `POST
 * /api/signup` (a caller who already owns this unverified username is
 * allowed to overwrite their own pending record with a fresh token).
 *
 * Written via a temp-file-then-`rename()` pattern, same overall shape as
 * `createSignupExclusive` above but deliberately using `rename()` instead of
 * `link()`: this function's whole purpose is to clobber whatever is already
 * at the final path, which is exactly what `rename()` does (and what
 * `link()`'s `EEXIST` would prevent). This avoids a truncated/partial record
 * on disk if the process crashes or hits ENOSPC mid-write, which a direct
 * `writeFile` onto the final path would not.
 */
export async function overwriteSignup(signupsDir: string, record: SignupRecord): Promise<void> {
  await mkdir(signupsDir, { recursive: true, mode: 0o700 });
  const finalPath = resolveSignupPath(signupsDir, record.username);
  const tempPath = join(signupsDir, `.${record.username}.${randomUUID()}.tmp`);
  const json = JSON.stringify(record, null, 2);

  try {
    await writeFile(tempPath, json, { encoding: 'utf-8', mode: 0o600 });
    await rename(tempPath, finalPath);
  } catch (err) {
    throw new StorageError(
      `failed to save signup record for "${record.username}": ${(err as Error).message}`,
      { cause: err },
    );
  } finally {
    // No-op once rename() has already moved the temp file away -- `force`
    // makes the ENOENT case silent, mirroring createSignupExclusive's own
    // cleanup finally.
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

/**
 * Scans every signup record in `signupsDir` for one whose `username` matches
 * `username` case-insensitively. Used by `POST /api/signup` to detect both
 * an exact-case duplicate/resend and a case-fold collision against a
 * differently-cased existing signup (no case-insensitive duplicate usernames
 * are allowed, mirroring `credentials.ts`'s own case-fold rule).
 */
export async function findSignupByUsernameCaseFold(
  signupsDir: string,
  username: string,
): Promise<SignupRecord | null> {
  const folded = username.toLowerCase();
  const filenames = await listSignupFilenames(signupsDir);
  for (const filename of filenames) {
    const record = await readSignupFile(join(signupsDir, filename));
    if (record !== null && record.username.toLowerCase() === folded) {
      return record;
    }
  }
  return null;
}

/**
 * Scans every signup record in `signupsDir` for one whose stored (already
 * normalized) `email` exactly matches `normalizedEmail`. `normalizedEmail`
 * is expected to already be `trim().toLowerCase()`d by the caller -- this
 * function does not normalize it itself, matching every stored `email`
 * already being normalized at write time.
 */
export async function findSignupByEmail(
  signupsDir: string,
  normalizedEmail: string,
): Promise<SignupRecord | null> {
  const filenames = await listSignupFilenames(signupsDir);
  for (const filename of filenames) {
    const record = await readSignupFile(join(signupsDir, filename));
    if (record !== null && record.email === normalizedEmail) {
      return record;
    }
  }
  return null;
}

/**
 * Best-effort deletion of expired *unverified* signup records, and returns
 * how many unverified records remain afterward (the caller in `app.ts` uses
 * this to enforce the unverified-account cap, the same role
 * `sweepStaleDemoAccounts` plays for `DEFAULT_DEMO_ACCOUNT_CAP`). Runs on
 * every `POST /api/signup` call, before a new record is written, so
 * abandoned unverified signups self-clean without a separate cron process.
 *
 * Unlike `sweepStaleDemoAccounts`, staleness here cannot be judged from file
 * `mtime` alone: a verified account's record is written once at signup and
 * then again at verification, but must never expire regardless of how old
 * either write is. Each record is parsed instead -- `verified: true` records
 * are always skipped (never deleted, never counted), and only `verified:
 * false` records are checked against `ttlMs` (via their own `createdAt`, not
 * file mtime).
 *
 * `now` defaults to `Date.now()` and is exposed as a parameter purely so
 * tests can control it deterministically -- mirrors `signSession`'s own
 * `now` parameter in `session.ts` for the same reason.
 *
 * Never throws, mirroring `sweepStaleDemoAccounts`'s structure closely: a
 * sweep failure (missing `signups/` dir before any signup has ever happened,
 * a transient FS error, a single corrupted record) must never block a new
 * signup from proceeding, so every error here is swallowed. A record that
 * couldn't be read/parsed/deleted has unknown survival and is not counted
 * either way, same as `sweepStaleDemoAccounts`'s per-file catch.
 */
export async function sweepExpiredSignups(
  signupsDir: string,
  ttlMs: number,
  now: number = Date.now(),
): Promise<{ unverifiedRemaining: number }> {
  try {
    const entries = await readdir(signupsDir);
    let unverifiedRemaining = 0;
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const filePath = join(signupsDir, entry);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const record = JSON.parse(raw) as SignupRecord;
        if (record.verified) {
          continue; // verified accounts never expire
        }
        // An unparseable createdAt (a corrupted record) must count as
        // already-expired -- Date.parse returning NaN would otherwise make
        // `now - NaN > ttlMs` false forever, letting a corrupted record
        // permanently occupy a slot under the unverified-account cap with no
        // way to self-heal.
        const createdAtMs = Date.parse(record.createdAt);
        const isExpired = Number.isNaN(createdAtMs) || now - createdAtMs > ttlMs;
        if (isExpired) {
          await rm(filePath, { force: true });
        } else {
          unverifiedRemaining += 1;
        }
      } catch {
        // A single file's read/parse/delete failing (concurrent sweep,
        // transient FS error, corrupted record, ...) must not abort the
        // sweep for every other file -- skip it and keep going.
      }
    }
    return { unverifiedRemaining };
  } catch {
    // Covers readdir failing outright (missing signups/ dir, permission
    // error, ...) -- treated the same as "nothing to sweep".
    return { unverifiedRemaining: 0 };
  }
}

/**
 * Checks a username/password pair against the signup store for `POST
 * /api/login`'s fallback path (tried only after `authenticate` against the
 * static `AUTH_USERS_JSON` credentials has already failed). Looked up by
 * exact, case-sensitive username -- like `findCredential` in `credentials.ts`,
 * not `findSignupByUsernameCaseFold` -- since this is a login check against a
 * single already-known account shape, not a duplicate/collision scan.
 *
 * The password compare runs *before* `verified` is consulted -- deliberately
 * the opposite of what may look fastest. If `verified === false`
 * short-circuited before the password compare, `POST /api/login` with *any*
 * password (no password knowledge required) would distinguish a pending
 * unverified username (403) from a nonexistent one (401), making
 * `/api/login` an unauthenticated account-existence oracle for every pending
 * signup -- see #105. Only a *correct* password on an unverified account
 * returns `'unverified'`; a wrong password returns `'invalid-password'`
 * regardless of verified status, indistinguishable from a wrong password
 * against a verified account.
 */
export async function checkSignupLogin(
  signupsDir: string,
  username: string,
  password: unknown,
): Promise<'ok' | 'unverified' | 'not-found' | 'invalid-password'> {
  const record = await readSignup(signupsDir, username);
  if (record === null) {
    return 'not-found';
  }
  const isValid = await verifyPassword(password, record.passwordHash);
  if (!isValid) {
    return 'invalid-password';
  }
  return record.verified ? 'ok' : 'unverified';
}
