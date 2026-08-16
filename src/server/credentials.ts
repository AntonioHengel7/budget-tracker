import bcrypt from 'bcryptjs';

/** Raised for any failure parsing/validating the `AUTH_USERS_JSON` env var. */
export class CredentialsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialsConfigError';
  }
}

export interface Credential {
  username: string;
  passwordHash: string;
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
 * invalid JSON, non-array JSON, or entries missing required fields.
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
  }

  return parsed;
}

/** Finds a credential by exact, case-sensitive username match. */
export function findCredential(credentials: Credential[], username: string): Credential | undefined {
  return credentials.find((c) => c.username === username);
}

/** Verifies a plaintext password against a bcrypt hash. */
export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}
