import { join } from 'node:path';
import { DomainError } from '../domain/errors.js';

/**
 * Raised when a username fails the canonical username-shape check (see
 * `isValidUsername`/`assertValidUsername` below). Extends `DomainError` so
 * it maps to a 400 response (config/input error) rather than an unhandled
 * 500 wherever request/config error mapping happens (see issue #17).
 */
export class InvalidUsernameError extends DomainError {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUsernameError';
  }
}

/**
 * The single canonical shape every username in this system must satisfy --
 * letters (either case), digits, underscore, hyphen; 1-32 chars. This is the
 * one source of truth: `credentials.ts` enforces it at config-load time (so
 * an invalid username can never be signed into a session token), and
 * `resolveUserStorePath` below enforces it again as a last line of defense
 * against path traversal and other unsafe filenames. Case is preserved, not
 * normalized -- "Antonio" and "antonio" are distinct usernames/files.
 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/;

/** Returns whether `username` matches the canonical allowed shape. */
export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

/** Throws `InvalidUsernameError` unless `username` matches the canonical allowed shape. */
export function assertValidUsername(username: string): void {
  if (!isValidUsername(username)) {
    throw new InvalidUsernameError(`Invalid username: ${JSON.stringify(username)}`);
  }
}

/**
 * Resolves the per-user JSON store path for a given username, e.g.
 * `resolveUserStorePath('/data', 'antonio')` -> `/data/antonio.json`.
 * Rejects any username that doesn't match the canonical allowed shape --
 * this is what keeps path traversal and other unsafe filenames out entirely.
 */
export function resolveUserStorePath(dataDir: string, username: string): string {
  assertValidUsername(username);
  return join(dataDir, `${username}.json`);
}

/**
 * Resolves the per-account signup record path for a given username, e.g.
 * `resolveSignupPath('/data/signups', 'antonio')` -> `/data/signups/antonio.json`.
 * Same shape and same rationale as `resolveUserStorePath` above -- rejects
 * any username that doesn't match the canonical allowed shape, which is what
 * keeps path traversal and other unsafe filenames out entirely. Callers pass
 * the already-computed `signups/` subdirectory (see `app.ts`'s `signupsDir`),
 * not `dataDir` itself, so signup records and budget store files never share
 * a directory or a filename collision.
 */
export function resolveSignupPath(signupsDir: string, username: string): string {
  assertValidUsername(username);
  return join(signupsDir, `${username}.json`);
}
