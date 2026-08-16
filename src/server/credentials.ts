import bcrypt from 'bcryptjs';
import { assertValidUsername } from './paths.js';

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
 * invalid JSON, non-array JSON, or entries missing required fields. Throws
 * `InvalidUsernameError` (from `./paths.js`) if any entry's username doesn't
 * match the canonical username shape -- enforced here, at config-load time,
 * so an invalid username (e.g. one containing the `.` that `session.ts`
 * uses as a token delimiter) can never reach `session.ts` or get signed
 * into a token in the first place.
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
    assertValidUsername(entry.username);
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

// A valid-format bcrypt hash that no real password will ever match, used by
// `authenticate` below to keep the bcrypt compare cost constant regardless
// of whether the username exists -- otherwise an unknown-username request
// returns in microseconds (object lookup) instead of ~100ms (bcrypt
// compare), which is itself a timing side-channel revealing valid usernames.
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-constant-time-compare', 10);

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
