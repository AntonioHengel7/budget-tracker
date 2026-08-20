import { describe, expect, it } from 'vitest';
import { hashPassword } from '../../../src/server/scripts/hashPassword.js';
import { loadCredentials } from '../../../src/server/credentials.js';

describe('hashPassword', () => {
  it('produces a hash that loads cleanly through loadCredentials', async () => {
    const passwordHash = await hashPassword('correct horse battery staple');
    const json = JSON.stringify([{ username: 'antonio', passwordHash }]);
    expect(loadCredentials(json)).toEqual([{ username: 'antonio', passwordHash }]);
  });
});
