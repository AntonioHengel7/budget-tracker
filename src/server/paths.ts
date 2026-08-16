import { join } from 'node:path';

/** Raised when a username fails the safe-storage-path shape check. */
export class InvalidUsernameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidUsernameError';
  }
}

const USERNAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

/**
 * Resolves the per-user JSON store path for a given username, e.g.
 * `resolveUserStorePath('/data', 'antonio')` -> `/data/antonio.json`.
 * Rejects any username that doesn't match the strict allowed shape
 * (lowercase letters, digits, underscore, hyphen; 1-32 chars) -- this is
 * what keeps path traversal and other unsafe filenames out entirely.
 */
export function resolveUserStorePath(dataDir: string, username: string): string {
  if (!USERNAME_PATTERN.test(username)) {
    throw new InvalidUsernameError(`Invalid username: ${JSON.stringify(username)}`);
  }
  return join(dataDir, `${username}.json`);
}
