import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  authenticate,
  CredentialsConfigError,
  findCredential,
  loadCredentials,
  verifyPassword,
} from '../../src/server/credentials.js';
import { InvalidUsernameError } from '../../src/server/paths.js';

describe('loadCredentials', () => {
  it('parses a valid JSON array', () => {
    const json = JSON.stringify([{ username: 'antonio', passwordHash: '$2a$...' }]);
    expect(loadCredentials(json)).toEqual([{ username: 'antonio', passwordHash: '$2a$...' }]);
  });

  it('throws when the env var is unset', () => {
    expect(() => loadCredentials(undefined)).toThrow(CredentialsConfigError);
  });

  it('throws when the env var is empty', () => {
    expect(() => loadCredentials('')).toThrow(CredentialsConfigError);
  });

  it('throws on invalid JSON', () => {
    expect(() => loadCredentials('{not json')).toThrow(CredentialsConfigError);
  });

  it('throws when the JSON is not an array', () => {
    expect(() => loadCredentials('{"username":"a"}')).toThrow(CredentialsConfigError);
  });

  it('throws when an entry is missing username or passwordHash', () => {
    expect(() => loadCredentials(JSON.stringify([{ username: 'a' }]))).toThrow(CredentialsConfigError);
  });

  it('throws InvalidUsernameError when an entry has a username outside the canonical shape', () => {
    const json = JSON.stringify([{ username: 'antonio.h', passwordHash: '$2a$...' }]);
    expect(() => loadCredentials(json)).toThrow(InvalidUsernameError);
  });
});

describe('findCredential', () => {
  const creds = [
    { username: 'antonio', passwordHash: 'h1' },
    { username: 'friend', passwordHash: 'h2' },
  ];

  it('finds an exact username match', () => {
    expect(findCredential(creds, 'friend')).toEqual({ username: 'friend', passwordHash: 'h2' });
  });

  it('returns undefined for no match, case-sensitively', () => {
    expect(findCredential(creds, 'Antonio')).toBeUndefined();
    expect(findCredential(creds, 'nobody')).toBeUndefined();
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct password against its bcrypt hash', async () => {
    const hash = await bcrypt.hash('correct horse', 4);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
  });

  it('returns false for the wrong password', async () => {
    const hash = await bcrypt.hash('correct horse', 4);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('returns false instead of throwing for a non-string password', async () => {
    const hash = await bcrypt.hash('correct horse', 4);
    expect(await verifyPassword(null, hash)).toBe(false);
    expect(await verifyPassword(undefined, hash)).toBe(false);
    expect(await verifyPassword(42, hash)).toBe(false);
  });
});

describe('authenticate', () => {
  it('returns true for a known username with the correct password', async () => {
    const hash = await bcrypt.hash('correct horse', 4);
    const creds = [{ username: 'antonio', passwordHash: hash }];
    expect(await authenticate(creds, 'antonio', 'correct horse')).toBe(true);
  });

  it('returns false for a known username with the wrong password', async () => {
    const hash = await bcrypt.hash('correct horse', 4);
    const creds = [{ username: 'antonio', passwordHash: hash }];
    expect(await authenticate(creds, 'antonio', 'wrong')).toBe(false);
  });

  it('returns false for an unknown username', async () => {
    const hash = await bcrypt.hash('correct horse', 4);
    const creds = [{ username: 'antonio', passwordHash: hash }];
    expect(await authenticate(creds, 'nobody', 'correct horse')).toBe(false);
  });

  it('always performs a bcrypt compare, even for an unknown username, to avoid a timing side-channel', async () => {
    const hash = await bcrypt.hash('correct horse', 4);
    const creds = [{ username: 'antonio', passwordHash: hash }];
    const compareSpy = vi.spyOn(bcrypt, 'compare');

    await authenticate(creds, 'nobody', 'correct horse');

    expect(compareSpy).toHaveBeenCalled();
    compareSpy.mockRestore();
  });

  it('returns false instead of throwing for a non-string password against an unknown username', async () => {
    const creds = [{ username: 'antonio', passwordHash: 'irrelevant' }];
    expect(await authenticate(creds, 'nobody', null)).toBe(false);
  });
});
