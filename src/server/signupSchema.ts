/**
 * On-disk shape of a self-service signup record (issue #104). One JSON file
 * per account, at `<dataDir>/signups/<username>.json` (see `signupStore.ts`
 * and `resolveSignupPath` in `paths.ts`), the same one-file-per-account
 * layout the existing per-user budget store already uses -- deliberately not
 * a database, per this feature's design constraints.
 */
export const SIGNUP_SCHEMA_VERSION = 1 as const;

export interface SignupRecord {
  readonly schemaVersion: typeof SIGNUP_SCHEMA_VERSION;
  readonly username: string;
  /** Normalized: `email.trim().toLowerCase()`. Comparisons against it must use an already-normalized input. */
  readonly email: string;
  /** bcrypt, hashed at `BCRYPT_COST` from `credentials.ts` -- the one pinned cost every password hash in this app uses. */
  readonly passwordHash: string;
  readonly verified: boolean;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, or `null` once `verified` is `true`. */
  readonly verifiedAt: string | null;
  /**
   * SHA-256 hex digest of the raw verification token, or `null` once
   * `verified` is `true`. Deliberately NOT bcrypt: bcrypt's slow-hash cost
   * exists to defend a human-guessable secret (a password) against offline
   * brute force. A verification token is `randomBytes(32)` -- 256 bits of
   * entropy, already computationally infeasible to guess or brute-force --
   * so hashing it with bcrypt would only add latency on every verification
   * click with zero corresponding security benefit. `BCRYPT_COST` stays
   * reserved for passwords only.
   */
  readonly verificationTokenHash: string | null;
  /** ISO 8601, or `null` once `verified` is `true`. */
  readonly verificationTokenExpiresAt: string | null;
}
