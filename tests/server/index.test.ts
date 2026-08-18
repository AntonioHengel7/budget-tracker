import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/server/index.js';

const VALID_SECRET = 'a'.repeat(32);
const VALID_AUTH_USERS_JSON = JSON.stringify([
  { username: 'antonio', passwordHash: '$2a$10$' + 'a'.repeat(53) },
]);

describe('boot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('boots successfully with valid env vars and defaults PORT to 8080', () => {
    vi.stubEnv('SESSION_SECRET', VALID_SECRET);
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);
    vi.stubEnv('PORT', undefined);

    const { app, port } = boot();
    expect(port).toBe(8080);
    expect(app).toBeDefined();
  });

  it('accepts a valid custom PORT', () => {
    vi.stubEnv('SESSION_SECRET', VALID_SECRET);
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);
    vi.stubEnv('PORT', '3000');

    const { port } = boot();
    expect(port).toBe(3000);
  });

  it.each([
    ['non-numeric', 'notaport'],
    ['zero', '0'],
    ['negative', '-1'],
    ['too large', '70000'],
    ['a float', '8080.5'],
  ])('throws a clear error and never starts listening for an invalid PORT (%s)', (_label, rawPort) => {
    vi.stubEnv('SESSION_SECRET', VALID_SECRET);
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);
    vi.stubEnv('PORT', rawPort);

    expect(() => boot()).toThrow(/PORT must be an integer between 1 and 65535/);
  });

  it('throws a clear error for a non-numeric TRUST_PROXY', () => {
    vi.stubEnv('SESSION_SECRET', VALID_SECRET);
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);
    vi.stubEnv('TRUST_PROXY', 'not-a-number');

    expect(() => boot()).toThrow(/TRUST_PROXY must be a non-negative integer hop count/);
  });

  it('throws when SESSION_SECRET is missing', () => {
    vi.stubEnv('SESSION_SECRET', undefined);
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);

    expect(() => boot()).toThrow(/SESSION_SECRET is not set/);
  });

  it('throws when SESSION_SECRET is shorter than 32 characters', () => {
    vi.stubEnv('SESSION_SECRET', 'too-short');
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);

    expect(() => boot()).toThrow(/SESSION_SECRET must be at least 32 characters/);
  });

  it('throws a clearly-labeled error when AUTH_USERS_JSON is malformed', () => {
    vi.stubEnv('SESSION_SECRET', VALID_SECRET);
    vi.stubEnv('AUTH_USERS_JSON', '{not json');

    expect(() => boot()).toThrow(/Invalid AUTH_USERS_JSON/);
  });

  it('wires STATIC_DIR through to the app, serving the SPA for a non-API route', async () => {
    const tmpWeb = await mkdtemp(join(tmpdir(), 'budget-static-dir-test-'));
    try {
      await writeFile(join(tmpWeb, 'index.html'), '<!doctype html><title>t</title>');

      vi.stubEnv('SESSION_SECRET', VALID_SECRET);
      vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);
      vi.stubEnv('STATIC_DIR', tmpWeb);

      const { app } = boot();
      const res = await request(app).get('/some/client/route');
      expect(res.status).toBe(200);
      expect(res.text).toContain('<title>t</title>');
    } finally {
      await rm(tmpWeb, { recursive: true, force: true });
    }
  });

  it('leaves the app API-only (no SPA fallback) when STATIC_DIR is unset', async () => {
    vi.stubEnv('SESSION_SECRET', VALID_SECRET);
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);
    vi.stubEnv('STATIC_DIR', undefined);

    const { app } = boot();
    const res = await request(app).get('/some/client/route');
    expect(res.status).toBe(404);
  });

  it('treats an empty STATIC_DIR the same as unset, not as process.cwd()', async () => {
    vi.stubEnv('SESSION_SECRET', VALID_SECRET);
    vi.stubEnv('AUTH_USERS_JSON', VALID_AUTH_USERS_JSON);
    vi.stubEnv('STATIC_DIR', '');

    const { app } = boot();
    const res = await request(app).get('/some/client/route');
    expect(res.status).toBe(404);
  });
});
