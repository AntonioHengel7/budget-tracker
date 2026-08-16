import { createHmac, timingSafeEqual } from 'node:crypto';

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function hmacHex(username: string, expiry: number, secret: string): string {
  return createHmac('sha256', secret).update(`${username}.${expiry}`).digest('hex');
}

/**
 * Signs a stateless session token of the form `<username>.<expiry>.<hmac-hex>`.
 * `now` is in epoch seconds and defaults to the current time -- exposed as a
 * parameter purely so tests can control expiry deterministically.
 *
 * Throws if `secret` is an empty string -- an empty HMAC key (e.g. from an
 * unset `SESSION_SECRET=` or a `?? ''` fallback) would let anyone forge a
 * valid session, so this fails loud instead of silently signing a forgeable
 * token.
 */
export function signSession(username: string, secret: string, now: number = nowSeconds()): string {
  if (secret === '') {
    throw new Error('Session secret must not be empty');
  }
  const expiry = now + THIRTY_DAYS_SECONDS;
  const signature = hmacHex(username, expiry, secret);
  return `${username}.${expiry}.${signature}`;
}

export interface SessionPayload {
  readonly username: string;
}

/**
 * Verifies a session token produced by `signSession`. Returns the decoded
 * payload when the token is well-formed, correctly signed, and not expired;
 * otherwise returns null. Never throws -- an empty `secret` is treated as
 * always-invalid (returns null) rather than throwing, so a misconfigured
 * secret fails closed on every request instead of crashing the handler.
 */
export function verifySession(
  token: string,
  secret: string,
  now: number = nowSeconds(),
): SessionPayload | null {
  if (secret === '') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [username, expiryRaw, signature] = parts;
  if (!username || !expiryRaw || !signature) {
    return null;
  }

  const expiry = Number(expiryRaw);
  if (!Number.isInteger(expiry)) {
    return null;
  }

  const expected = hmacHex(username, expiry, secret);
  const expectedBuf = Buffer.from(expected, 'hex');
  const actualBuf = Buffer.from(signature, 'hex');
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
    return null;
  }

  if (now > expiry) {
    return null;
  }

  return { username };
}
