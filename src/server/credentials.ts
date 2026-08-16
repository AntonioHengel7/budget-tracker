import bcrypt from 'bcryptjs';
import { assertValidUsername, InvalidUsernameError } from './paths.js';

/** Raised for any failure parsing/validating the `AUTH_USERS_JSON` env var. */
export class CredentialsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsConfigError';
  }
}

export interface Credential {
  readonly username: string;
  readonly passwordHash: string;
}

/**
 * The one pinned bcrypt cost factor every hash in `AUTH_USERS_JSON` must
 * use. This is the single source of truth for "the cost the constant-time
 * comparison in `authenticate` depends on" -- `DUMMY_HASH` below is derived
 * from it (not a second hardcoded literal), and `loadCredentials` rejects
 * any configured hash whose cost doesn't match it. Without this pinning, a
 * configured hash at a different cost than the dummy hash reopens the exact
 * username-timing oracle `authenticate` exists to close: cost 12 vs. this
 * constant produces a measurable delta, and cost 4 vs. this constant
 * inverts it (known user faster than unknown).
 */
export const BCRYPT_COST = 10;

// $2a/$2b/$2y prefix, two-digit cost, then a 53-char base64-like salt+hash.
const BCRYPT_HASH_PATTERN = /^\$2[aby]\$(\d{2})\$[A-Za-z0-9./]{53}$/;

function parseBcryptHash(hash: string): { cost: number } | null {
  const match = BCRYPT_HASH_PATTERN.exec(hash);
  if (!match || !match[1]) {
    return null;
  }
  return { cost: Number(match[1]) };
}

function isCredential(value: unknown): value is Credential {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record['username'] === 'string' && typeof record['passwordHash'] === 'string';
}

/**
 * Parses the raw `AUTH_USERS_JSON` env var value into a list of credentials.
 * Throws `CredentialsConfigError` for anything malformed -- missing env var,
 * invalid JSON, non-array JSON, entries missing required fields, an entry
 * whose username doesn't match the canonical username shape (enforced here,
 * at config-load time, so an invalid username -- e.g. one containing the
 * `.` that `session.ts` uses as a token delimiter -- can never reach
 * `session.ts` or get signed into a token in the first place), or an entry
 * whose `passwordHash` isn't a well-formed bcrypt hash at the pinned cost
 * factor (`BCRYPT_COST`) -- required for `authenticate`'s constant-time
 * guarantee to actually hold. This is a single documented error type: a
 * caller only ever needs to catch `CredentialsConfigError`.
 */
export function loadCredentials(raw: string | undefined): Credential[] {
  if (raw === undefined || raw === '') {
    throw new CredentialsConfigError('AUTH_USERS_JSON is not set');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialsConfigError('AUTH_USERS_JSON is not valid JSON');
  }

  if (!Array.isArray(parsed)) {
    throw new CredentialsConfigError('AUTH_USERS_JSON must be a JSON array');
  }

  for (const entry of parsed) {
    if (!isCredential(entry)) {
      throw new CredentialsConfigError(
        'AUTH_USERS_JSON entries must each have a string "username" and "passwordHash"',
      );
    }

    try {
      assertValidUsername(entry.username);
    } catch (err) {
      if (err instanceof InvalidUsernameError) {
        throw new CredentialsConfigError(`AUTH_USERS_JSON has an invalid username: ${err.message}`);
      }
      throw err;
    }

    const shape = parseBcryptHash(entry.passwordHash);
    if (!shape) {
      throw new CredentialsConfigError(
        `AUTH_USERS_JSON passwordHash for "${entry.username}" is not a well-formed bcrypt hash`,
      );
    }
    if (shape.cost !== BCRYPT_COST) {
      throw new CredentialsConfigError(
        `AUTH_USERS_JSON passwordHash for "${entry.username}" has bcrypt cost ${shape.cost}, expected ${BCRYPT_COST}`,
      );
    }
  }

  return parsed;
}

/**
 * Finds a credential by exact, case-sensitive username match.
 *
 * WARNING: do not use this as a login check on its own -- returning early on
 * `undefined` (no matching username) skips the bcrypt compare entirely,
 * which is a timing side-channel that reveals which usernames exist. Use
 * `authenticate` for anything that checks a password against user input.
 */
export function findCredential(credentials: Credential[], username: string): Credential | undefined {
  return credentials.find((c) => c.username === username);
}

/**
 * Verifies a plaintext password against a bcrypt hash.
 *
 * WARNING: do not use this alone to gate a login check for a *possibly
 * unknown* username -- see `authenticate`. `password` is typed `unknown`
 * because it ultimately comes from a JSON request body, where TypeScript's
 * compile-time type is not a runtime guarantee; a non-string value returns
 * `false` instead of letting bcrypt throw.
 */
export function verifyPassword(password: unknown, passwordHash: string): Promise<boolean> {
  if (typeof password !== 'string') {
    return Promise.resolve(false);
  }
  return bcrypt.compare(password, passwordHash);
}

// A valid-format bcrypt hash, at the pinned BCRYPT_COST, that no real
// password will ever match. Used by `authenticate` below to keep the
// bcrypt compare cost constant regardless of whether the username exists --
// otherwise an unknown-username request returns in microseconds (object
// lookup) instead of ~100ms (bcrypt compare), which is itself a timing
// side-channel revealing valid usernames.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-constant-time-compare', BCRYPT_COST);

/**
 * Authenticates a username/password pair against a list of credentials.
 * Always performs a bcrypt compare -- even for an unknown username, against
 * a fixed dummy hash -- so there is no way to accidentally short-circuit
 * before the bcrypt call and leak which usernames exist via timing.
 */
export async function authenticate(
  credentials: Credential[],
  username: string,
  password: unknown,
): Promise<boolean> {
  const credential = findCredential(credentials, username);
  const hash = credential ? credential.passwordHash : DUMMY_HASH;
  const isValid = await verifyPassword(password, hash);
  return credential !== undefined && isValid;
}
