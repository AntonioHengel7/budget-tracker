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
 * lowercase letters, digits, underscore, hyphen; 1-32 chars. This is the one
 * source of truth: `credentials.ts` enforces it at config-load time (so an
 * invalid username can never be signed into a session token), and
 * `resolveUserStorePath` below enforces it again as a last line of defense
 * against path traversal and other unsafe filenames.
 */
const USERNAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

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
