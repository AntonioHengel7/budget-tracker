import { describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import {
  CredentialsConfigError,
  findCredential,
  loadCredentials,
  verifyPassword,
} from '../../src/server/credentials.js';

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
});
