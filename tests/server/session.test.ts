import { describe, expect, it } from 'vitest';
import { signSession, verifySession } from '../../src/server/session.js';

describe('session sign/verify', () => {
  const SECRET = 'test-secret';

  it('round-trips a freshly signed token', () => {
    const now = 1_700_000_000;
    const token = signSession('antonio', SECRET, now);
    const result = verifySession(token, SECRET, now + 10);
    expect(result).toEqual({ username: 'antonio' });
  });

  it('rejects a token past its expiry', () => {
    const now = 1_700_000_000;
    const token = signSession('antonio', SECRET, now);
    const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60;
    const result = verifySession(token, SECRET, now + THIRTY_ONE_DAYS);
    expect(result).toBeNull();
  });

  it('rejects a token verified with the wrong secret', () => {
    const token = signSession('antonio', SECRET);
    expect(verifySession(token, 'wrong-secret')).toBeNull();
  });

  it('rejects a tampered username with the original signature reused', () => {
    const now = 1_700_000_000;
    const token = signSession('antonio', SECRET, now);
    const parts = token.split('.');
    const tampered = `mallory.${parts[1]}.${parts[2]}`;
    expect(verifySession(tampered, SECRET, now + 10)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifySession('not-a-real-token', SECRET)).toBeNull();
    expect(verifySession('', SECRET)).toBeNull();
    expect(verifySession('a.b', SECRET)).toBeNull();
  });

});

describe('session secret guard', () => {
  it('signSession throws on an empty secret instead of silently signing a forgeable token', () => {
    expect(() => signSession('bob', '')).toThrow();
  });

  it('verifySession rejects (never validates) a token when checked against an empty secret', () => {
    const now = 1_700_000_000;
    const token = signSession('bob', 'a-real-secret', now);
    expect(verifySession(token, '', now + 10)).toBeNull();
  });
});
