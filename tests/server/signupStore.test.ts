import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StorageError } from '../../src/storage/jsonStore.js';
import { SIGNUP_SCHEMA_VERSION } from '../../src/server/signupSchema.js';
import type { SignupRecord } from '../../src/server/signupSchema.js';
import {
  checkSignupLogin,
  createSignupExclusive,
  findSignupByEmail,
  findSignupByUsernameCaseFold,
  overwriteSignup,
  readSignup,
  sweepExpiredSignups,
} from '../../src/server/signupStore.js';

// Low bcrypt cost -- fast tests, not production (mirrors api.integration.test.ts).
const TEST_BCRYPT_COST = 4;

function makeRecord(overrides: Partial<SignupRecord> = {}): SignupRecord {
  return {
    schemaVersion: SIGNUP_SCHEMA_VERSION,
    username: 'antonio',
    email: 'antonio@example.com',
    passwordHash: bcrypt.hashSync('correct horse battery staple', TEST_BCRYPT_COST),
    verified: false,
    createdAt: new Date().toISOString(),
    verifiedAt: null,
    verificationTokenHash: createHash('sha256').update('atoken').digest('hex'),
    verificationTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe('signupStore', () => {
  let dataDir: string;
  let signupsDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'budget-signup-store-test-'));
    signupsDir = join(dataDir, 'signups');
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('readSignup', () => {
    it('returns null for a username with no record', async () => {
      await expect(readSignup(signupsDir, 'nobody')).resolves.toBeNull();
    });

    it('returns the record for an existing username', async () => {
      const record = makeRecord();
      await createSignupExclusive(signupsDir, record);
      await expect(readSignup(signupsDir, 'antonio')).resolves.toEqual(record);
    });

    it('throws StorageError for a corrupted record file', async () => {
      const record = makeRecord();
      await createSignupExclusive(signupsDir, record);
      await rm(join(signupsDir, 'antonio.json'));
      await writeFile(join(signupsDir, 'antonio.json'), '{not valid json', 'utf-8');
      await expect(readSignup(signupsDir, 'antonio')).rejects.toThrow(StorageError);
    });
  });

  describe('createSignupExclusive', () => {
    it('creates a brand-new record and returns "created"', async () => {
      const record = makeRecord();
      const result = await createSignupExclusive(signupsDir, record);
      expect(result).toBe('created');
      await expect(readSignup(signupsDir, 'antonio')).resolves.toEqual(record);
    });

    it('writes the file with mode 0600 and the directory with mode 0700', async () => {
      const record = makeRecord();
      await createSignupExclusive(signupsDir, record);
      const fileStats = await stat(join(signupsDir, 'antonio.json'));
      const dirStats = await stat(signupsDir);
      expect(fileStats.mode & 0o777).toBe(0o600);
      expect(dirStats.mode & 0o777).toBe(0o700);
    });

    // Most important test in this file: a second exclusive create for the
    // same username must not clobber the first record -- proving `link()`,
    // not `rename()`, is really what's used underneath.
    it('returns "exists" on a second call for the same username, without clobbering the first record', async () => {
      const first = makeRecord({ email: 'first@example.com' });
      const second = makeRecord({ email: 'second@example.com' });

      const firstResult = await createSignupExclusive(signupsDir, first);
      const secondResult = await createSignupExclusive(signupsDir, second);

      expect(firstResult).toBe('created');
      expect(secondResult).toBe('exists');

      const stored = await readSignup(signupsDir, 'antonio');
      expect(stored).toEqual(first);
      expect(stored?.email).toBe('first@example.com');
    });

    it('never leaves a stray .tmp file behind, on success or on "exists"', async () => {
      await createSignupExclusive(signupsDir, makeRecord());
      await createSignupExclusive(signupsDir, makeRecord({ email: 'other@example.com' }));

      const entries = await readdir(signupsDir);
      expect(entries).toEqual(['antonio.json']);
    });
  });

  describe('overwriteSignup', () => {
    it('creates the directory and file when neither exists yet', async () => {
      const record = makeRecord();
      await overwriteSignup(signupsDir, record);
      await expect(readSignup(signupsDir, 'antonio')).resolves.toEqual(record);
    });

    it('replaces an existing record entirely', async () => {
      await createSignupExclusive(signupsDir, makeRecord({ email: 'old@example.com' }));
      const updated = makeRecord({ email: 'new@example.com', verified: true, verifiedAt: new Date().toISOString() });
      await overwriteSignup(signupsDir, updated);
      await expect(readSignup(signupsDir, 'antonio')).resolves.toEqual(updated);
    });

    // Pins the temp-file+rename() rewrite: reverting to a direct writeFile
    // onto the final path wouldn't fail this test on a successful write, but
    // this at least locks in that the temp file is always cleaned up rather
    // than left behind -- mirrors createSignupExclusive's own
    // "never leaves a stray .tmp file" test above.
    it('never leaves a stray .tmp file behind after a successful overwrite', async () => {
      await createSignupExclusive(signupsDir, makeRecord({ email: 'old@example.com' }));
      await overwriteSignup(signupsDir, makeRecord({ email: 'new@example.com' }));

      const entries = await readdir(signupsDir);
      expect(entries).toEqual(['antonio.json']);
    });
  });

  describe('findSignupByUsernameCaseFold', () => {
    it('returns null when the signups directory does not exist yet', async () => {
      await expect(findSignupByUsernameCaseFold(signupsDir, 'antonio')).resolves.toBeNull();
    });

    it('finds an exact-case match', async () => {
      const record = makeRecord();
      await createSignupExclusive(signupsDir, record);
      await expect(findSignupByUsernameCaseFold(signupsDir, 'antonio')).resolves.toEqual(record);
    });

    it('finds a case-fold match with a different exact case', async () => {
      const record = makeRecord({ username: 'Antonio' });
      await createSignupExclusive(signupsDir, record);
      const found = await findSignupByUsernameCaseFold(signupsDir, 'antonio');
      expect(found?.username).toBe('Antonio');
    });

    it('returns null when no record matches', async () => {
      await createSignupExclusive(signupsDir, makeRecord());
      await expect(findSignupByUsernameCaseFold(signupsDir, 'someoneelse')).resolves.toBeNull();
    });
  });

  describe('findSignupByEmail', () => {
    it('returns null when the signups directory does not exist yet', async () => {
      await expect(findSignupByEmail(signupsDir, 'antonio@example.com')).resolves.toBeNull();
    });

    it('finds a record by its normalized email', async () => {
      const record = makeRecord({ email: 'antonio@example.com' });
      await createSignupExclusive(signupsDir, record);
      await expect(findSignupByEmail(signupsDir, 'antonio@example.com')).resolves.toEqual(record);
    });

    it('returns null when no record has that email', async () => {
      await createSignupExclusive(signupsDir, makeRecord({ email: 'antonio@example.com' }));
      await expect(findSignupByEmail(signupsDir, 'nobody@example.com')).resolves.toBeNull();
    });
  });

  describe('sweepExpiredSignups', () => {
    it('returns unverifiedRemaining: 0 when the signups directory does not exist yet', async () => {
      await expect(sweepExpiredSignups(signupsDir, 1000)).resolves.toEqual({ unverifiedRemaining: 0 });
    });

    it('never deletes a verified record regardless of createdAt age', async () => {
      const old = new Date(Date.now() - 1_000_000).toISOString();
      const record = makeRecord({ verified: true, createdAt: old, verificationTokenHash: null, verificationTokenExpiresAt: null });
      await createSignupExclusive(signupsDir, record);

      const result = await sweepExpiredSignups(signupsDir, 1000);

      expect(result.unverifiedRemaining).toBe(0); // verified records aren't counted either
      await expect(readSignup(signupsDir, 'antonio')).resolves.toEqual(record);
    });

    it('deletes an expired unverified record and keeps a fresh one', async () => {
      const staleCreatedAt = new Date(Date.now() - 10_000).toISOString();
      const stale = makeRecord({ username: 'stale-user', createdAt: staleCreatedAt });
      const fresh = makeRecord({ username: 'fresh-user', createdAt: new Date().toISOString() });
      await createSignupExclusive(signupsDir, stale);
      await createSignupExclusive(signupsDir, fresh);

      const result = await sweepExpiredSignups(signupsDir, 5_000);

      expect(result.unverifiedRemaining).toBe(1);
      await expect(readSignup(signupsDir, 'stale-user')).resolves.toBeNull();
      await expect(readSignup(signupsDir, 'fresh-user')).resolves.toEqual(fresh);
    });

    // Pins the Number.isNaN(createdAtMs) guard: reverting to the old
    // `now - Date.parse(record.createdAt) > ttlMs` check makes this fail,
    // since `now - NaN` is NaN and `NaN > ttlMs` is always false, letting a
    // corrupted record survive the sweep forever.
    it('deletes an unverified record with an unparseable createdAt, rather than letting it survive forever', async () => {
      const record = makeRecord({ createdAt: 'not-a-date' });
      await createSignupExclusive(signupsDir, record);

      const result = await sweepExpiredSignups(signupsDir, 1000);

      expect(result.unverifiedRemaining).toBe(0);
      await expect(readSignup(signupsDir, 'antonio')).resolves.toBeNull();
    });

    it('honors an explicit `now` for deterministic testing', async () => {
      const createdAt = new Date('2026-01-01T00:00:00.000Z').toISOString();
      const record = makeRecord({ createdAt });
      await createSignupExclusive(signupsDir, record);

      const beforeExpiry = Date.parse(createdAt) + 500;
      const afterExpiry = Date.parse(createdAt) + 1500;

      const stillFresh = await sweepExpiredSignups(signupsDir, 1000, beforeExpiry);
      expect(stillFresh.unverifiedRemaining).toBe(1);

      const nowExpired = await sweepExpiredSignups(signupsDir, 1000, afterExpiry);
      expect(nowExpired.unverifiedRemaining).toBe(0);
      await expect(readSignup(signupsDir, 'antonio')).resolves.toBeNull();
    });
  });

  describe('checkSignupLogin', () => {
    it('returns "not-found" for a username with no record', async () => {
      await expect(checkSignupLogin(signupsDir, 'nobody', 'whatever')).resolves.toBe('not-found');
    });

    it('returns "unverified" before ever attempting a password compare', async () => {
      const password = 'correct horse battery staple';
      const record = makeRecord({
        verified: false,
        passwordHash: bcrypt.hashSync(password, TEST_BCRYPT_COST),
      });
      await createSignupExclusive(signupsDir, record);

      // Deliberately the *correct* password -- if checkSignupLogin ran the
      // bcrypt compare first and only checked `verified` afterward, this
      // would still return 'ok'. Getting 'unverified' back proves the
      // verified check runs (and short-circuits) before any password compare.
      await expect(checkSignupLogin(signupsDir, 'antonio', password)).resolves.toBe('unverified');
    });

    it('returns "ok" for a verified account with the correct password', async () => {
      const password = 'correct horse battery staple';
      const record = makeRecord({
        verified: true,
        verifiedAt: new Date().toISOString(),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        passwordHash: bcrypt.hashSync(password, TEST_BCRYPT_COST),
      });
      await createSignupExclusive(signupsDir, record);

      await expect(checkSignupLogin(signupsDir, 'antonio', password)).resolves.toBe('ok');
    });

    it('returns "invalid-password" (not "unverified") for an unverified account given the WRONG password -- no password knowledge must never disclose pending-account existence', async () => {
      const record = makeRecord({
        verified: false,
        passwordHash: bcrypt.hashSync('correct horse battery staple', TEST_BCRYPT_COST),
      });
      await createSignupExclusive(signupsDir, record);

      await expect(checkSignupLogin(signupsDir, 'antonio', 'totally wrong')).resolves.toBe(
        'invalid-password',
      );
    });

    it('returns "invalid-password" for a verified account with the wrong password', async () => {
      const record = makeRecord({
        verified: true,
        verifiedAt: new Date().toISOString(),
        verificationTokenHash: null,
        verificationTokenExpiresAt: null,
        passwordHash: bcrypt.hashSync('correct horse battery staple', TEST_BCRYPT_COST),
      });
      await createSignupExclusive(signupsDir, record);

      await expect(checkSignupLogin(signupsDir, 'antonio', 'wrong')).resolves.toBe('invalid-password');
    });
  });
});
