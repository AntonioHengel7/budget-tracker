import { describe, expect, it } from 'vitest';
import { DomainError } from '../../src/domain/errors.js';
import {
  assertValidUsername,
  InvalidUsernameError,
  isValidUsername,
  resolveSignupPath,
  resolveUserStorePath,
} from '../../src/server/paths.js';

describe('resolveUserStorePath', () => {
  it('resolves a valid username to <dataDir>/<username>.json', () => {
    expect(resolveUserStorePath('/data', 'antonio')).toBe('/data/antonio.json');
  });

  it('accepts lowercase letters, digits, underscore, and hyphen', () => {
    expect(() => resolveUserStorePath('/data', 'a_b-2')).not.toThrow();
  });

  it('accepts uppercase letters, preserving case in the resolved path', () => {
    expect(resolveUserStorePath('/data', 'AntonioHengel')).toBe('/data/AntonioHengel.json');
  });

  it('treats usernames differing only in case as distinct (case is not normalized)', () => {
    expect(resolveUserStorePath('/data', 'Antonio')).not.toBe(resolveUserStorePath('/data', 'antonio'));
  });

  it.each([
    ['empty string', ''],
    ['path traversal', '../../etc/passwd'],
    ['contains a slash', 'a/b'],
    ['contains a dot', 'antonio.json'],
    ['too long', 'a'.repeat(33)],
    ['contains a space', 'antonio hengel'],
  ])('rejects %s', (_label, username) => {
    expect(() => resolveUserStorePath('/data', username)).toThrow(InvalidUsernameError);
  });

  it('InvalidUsernameError extends this repo\'s DomainError, so it maps to a 400 not an unhandled 500', () => {
    expect(new InvalidUsernameError('bad username')).toBeInstanceOf(DomainError);
  });
});

describe('resolveSignupPath', () => {
  it('resolves a valid username to <signupsDir>/<username>.json', () => {
    expect(resolveSignupPath('/data/signups', 'antonio')).toBe('/data/signups/antonio.json');
  });

  it('preserves case, treating usernames differing only in case as distinct', () => {
    expect(resolveSignupPath('/data/signups', 'Antonio')).not.toBe(
      resolveSignupPath('/data/signups', 'antonio'),
    );
  });

  it.each([
    ['empty string', ''],
    ['path traversal', '../../etc/passwd'],
    ['contains a slash', 'a/b'],
    ['contains a dot', 'antonio.json'],
    ['too long', 'a'.repeat(33)],
  ])('rejects %s', (_label, username) => {
    expect(() => resolveSignupPath('/data/signups', username)).toThrow(InvalidUsernameError);
  });
});

describe('isValidUsername / assertValidUsername', () => {
  it('is the same canonical check resolveUserStorePath uses under the hood', () => {
    expect(isValidUsername('antonio')).toBe(true);
    expect(isValidUsername('AntonioHengel')).toBe(true);
    expect(isValidUsername('antonio.h')).toBe(false);
    expect(() => assertValidUsername('antonio.h')).toThrow(InvalidUsernameError);
    expect(() => assertValidUsername('antonio')).not.toThrow();
  });
});
