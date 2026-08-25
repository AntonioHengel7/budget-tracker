import { mkdtemp, readFile, rm, writeFile, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';
import { emptyStore } from '../../src/storage/schema.js';

// supertest talks plain HTTP, never HTTPS -- a Secure-flagged cookie (the
// createApp default, per #17's review) is correctly never replayed by
// superagent's cookie jar back to a plain-HTTP origin. Every createApp() call
// below that relies on an authenticated round trip opts into insecureCookies
// for that reason, exactly as a real local-HTTP (non-Fly, non-TLS) deployment
// would need to via INSECURE_COOKIES=true.
describe('web API', () => {
  let dataDir: string;
  let app: ReturnType<typeof createApp>;
  const PASSWORD = 'correct horse battery staple';
  let passwordHash: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'budget-api-test-'));
    passwordHash = await bcrypt.hash(PASSWORD, 4); // low cost factor -- fast tests, not production
    app = createApp({
      dataDir,
      credentials: [{ username: 'antonio', passwordHash }],
      sessionSecret: 'test-secret',
      insecureCookies: true,
    });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('exposes an unauthenticated health check endpoint', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    const res = await request(app).get('/api/status?period=2026-08');
    expect(res.status).toBe(401);
  });

  it('rejects login with the wrong password and sets no cookie', async () => {
    const res = await request(app).post('/api/login').send({ username: 'antonio', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects login for an unknown username', async () => {
    const res = await request(app).post('/api/login').send({ username: 'nobody', password: PASSWORD });
    expect(res.status).toBe(401);
  });

  it('logs in with correct credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app).post('/api/login').send({ username: 'antonio', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ username: 'antonio' });
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies).toBeDefined();
    expect(cookies.some((c) => c.startsWith('session=') && c.includes('HttpOnly'))).toBe(true);
  });

  it('allows an authenticated round trip: add a transaction, then see it in the list', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ username: 'antonio', password: PASSWORD });

    const add = await agent.post('/api/transactions').send({
      amount: '42.50',
      category: 'groceries',
      kind: 'expense',
      date: '2026-08-14',
    });
    expect(add.status).toBe(201);
    expect(add.body.transaction.category).toBe('groceries');

    const list = await agent.get('/api/transactions');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
  });

  // Covers DELETE /api/limits/:category (#83), mirroring the auth/success/
  // not-found shape of DELETE /api/transactions/:id above.
  describe('DELETE /api/limits/:category', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await request(app).delete('/api/limits/groceries');
      expect(res.status).toBe(401);
    });

    it('removes an existing category budget and returns it', async () => {
      const agent = request.agent(app);
      await agent.post('/api/login').send({ username: 'antonio', password: PASSWORD });

      const put = await agent
        .put('/api/limits')
        .send({ category: 'groceries', amount: '100', effectiveFrom: '2026-08' });
      expect(put.status).toBe(200);

      const del = await agent.delete('/api/limits/groceries');
      expect(del.status).toBe(200);
      expect(del.body).toEqual(put.body);

      const stored = JSON.parse(await readFile(join(dataDir, 'antonio.json'), 'utf-8'));
      expect(stored.budgets).toEqual([]);
    });

    it('responds 400 for a category with no budget', async () => {
      const agent = request.agent(app);
      await agent.post('/api/login').send({ username: 'antonio', password: PASSWORD });

      const res = await agent.delete('/api/limits/nope');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('nope');
    });
  });

  it('ignores a client-supplied username/userId in the request body -- data is always scoped by the session, never by client input', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ username: 'antonio', password: PASSWORD });

    await agent.post('/api/transactions').send({
      amount: '10',
      category: 'test',
      kind: 'expense',
      date: '2026-08-14',
      username: 'someone-else',
      userId: 'someone-else',
    });

    const antonioFile = join(dataDir, 'antonio.json');
    const someoneElseFile = join(dataDir, 'someone-else.json');
    const stored = JSON.parse(await readFile(antonioFile, 'utf-8'));
    expect(stored.transactions).toHaveLength(1);
    await expect(access(someoneElseFile)).rejects.toThrow();
  });

  it('rejects a session cookie signed with a different secret', async () => {
    const otherApp = createApp({
      dataDir,
      credentials: [{ username: 'antonio', passwordHash }],
      sessionSecret: 'a-completely-different-secret',
      insecureCookies: true,
    });
    const loginOnOther = await request(otherApp)
      .post('/api/login')
      .send({ username: 'antonio', password: PASSWORD });
    const cookie = (loginOnOther.headers['set-cookie'] as unknown as string[])[0];

    const res = await request(app).get('/api/me').set('Cookie', cookie ?? '');
    expect(res.status).toBe(401);
  });

  it('serves the SPA index.html for a non-API route when staticDir is configured, and never for /api routes', async () => {
    const tmpWeb = await mkdtemp(join(tmpdir(), 'budget-web-test-'));
    await writeFile(join(tmpWeb, 'index.html'), '<!doctype html><title>t</title>');
    const staticApp = createApp({
      dataDir,
      credentials: [{ username: 'antonio', passwordHash }],
      sessionSecret: 'test-secret',
      staticDir: tmpWeb,
    });

    const page = await request(staticApp).get('/some/client/route');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>t</title>');

    const apiFallthrough = await request(staticApp).get('/api/does-not-exist');
    expect(apiFallthrough.status).not.toBe(200);

    await rm(tmpWeb, { recursive: true, force: true });
  });

  it('maps a corrupted store file to a generic 500 without leaking the file path or internal message', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ username: 'antonio', password: PASSWORD });

    // Write a corrupted store file directly, bypassing the API, to simulate a
    // hand-edited or otherwise corrupted store -- loadStore throws a
    // StorageError whose message embeds the absolute file path.
    await writeFile(join(dataDir, 'antonio.json'), '{not valid json', 'utf-8');

    const res = await agent.get('/api/status?period=2026-08');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal server error' });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(dataDir);
    expect(raw).not.toContain('antonio.json');
    expect(raw).not.toContain('invalid JSON');
  });

  it('rejects a malformed JSON request body with a clean 400, not a 500', async () => {
    const res = await request(app)
      .post('/api/login')
      .set('content-type', 'application/json')
      .send('{not valid json');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'malformed JSON request body' });
  });

  it('rejects a request body exceeding the size limit with a 413, not a 500', async () => {
    // express.json() defaults to a 100kb limit; send a valid-JSON body well
    // past that so the only thing under test is the size check, not the parser.
    const oversizedNote = 'x'.repeat(200 * 1024);
    const res = await request(app)
      .post('/api/login')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ username: 'antonio', password: PASSWORD, note: oversizedNote }));

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'request body too large' });
  });

  it('rate-limits repeated /api/login attempts from the same IP', async () => {
    const limitedApp = createApp({
      dataDir,
      credentials: [{ username: 'antonio', passwordHash }],
      sessionSecret: 'test-secret',
      insecureCookies: true,
      loginRateLimit: { windowMs: 60_000, max: 3 },
    });

    const agent = request.agent(limitedApp);
    for (let i = 0; i < 3; i += 1) {
      const res = await agent.post('/api/login').send({ username: 'antonio', password: 'wrong' });
      expect(res.status).toBe(401);
    }

    const limited = await agent.post('/api/login').send({ username: 'antonio', password: 'wrong' });
    expect(limited.status).toBe(429);

    // Even correct credentials are rate-limited once the window is exhausted.
    const limitedWithCorrectPassword = await agent
      .post('/api/login')
      .send({ username: 'antonio', password: PASSWORD });
    expect(limitedWithCorrectPassword.status).toBe(429);
  });

  it('rate-limits repeated requests to a non-login /api route from the same IP', async () => {
    const limitedApp = createApp({
      dataDir,
      credentials: [{ username: 'antonio', passwordHash }],
      sessionSecret: 'test-secret',
      insecureCookies: true,
      apiRateLimit: { windowMs: 60_000, max: 3 },
    });

    const agent = request.agent(limitedApp);
    // Unauthenticated requests still count against the general limiter --
    // it sits in front of authMiddleware, since even a fast-failing 401
    // costs compute/bandwidth on a usage-billed machine.
    for (let i = 0; i < 3; i += 1) {
      const res = await agent.get('/api/status?period=2026-08');
      expect(res.status).toBe(401);
    }

    const limited = await agent.get('/api/status?period=2026-08');
    expect(limited.status).toBe(429);
  });

  it('counts /api/login requests against the general limiter too, not just the login-specific one', async () => {
    // apiRateLimit.max is set far below loginRateLimit.max so the general
    // limiter trips first -- proving /api/login consumes general-limiter
    // budget on top of its own tighter limiter, and the two can't be used to
    // bypass each other by exhausting only one of the two independent counters.
    const limitedApp = createApp({
      dataDir,
      credentials: [{ username: 'antonio', passwordHash }],
      sessionSecret: 'test-secret',
      insecureCookies: true,
      apiRateLimit: { windowMs: 60_000, max: 3 },
      loginRateLimit: { windowMs: 60_000, max: 100 },
    });

    const agent = request.agent(limitedApp);
    for (let i = 0; i < 3; i += 1) {
      const res = await agent.post('/api/login').send({ username: 'antonio', password: 'wrong' });
      expect(res.status).toBe(401);
    }

    const limited = await agent.post('/api/login').send({ username: 'antonio', password: 'wrong' });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: 'too many requests, try again later' });
  });

  it('never rate-limits /healthz, even after exceeding the general API limit', async () => {
    const limitedApp = createApp({
      dataDir,
      credentials: [{ username: 'antonio', passwordHash }],
      sessionSecret: 'test-secret',
      insecureCookies: true,
      apiRateLimit: { windowMs: 60_000, max: 3 },
    });

    const agent = request.agent(limitedApp);

    // Exhaust the general API limit.
    for (let i = 0; i < 3; i += 1) {
      await agent.get('/api/status?period=2026-08');
    }
    const limited = await agent.get('/api/status?period=2026-08');
    expect(limited.status).toBe(429);

    // /healthz is unaffected by the exhausted /api limit.
    for (let i = 0; i < 5; i += 1) {
      const health = await agent.get('/healthz');
      expect(health.status).toBe(200);
    }
  });

  describe('POST /api/demo', () => {
    it('creates a seeded demo account, sets a session cookie, and lets an authenticated follow-up read the seeded transactions', async () => {
      const agent = request.agent(app);
      const res = await agent.post('/api/demo');

      expect(res.status).toBe(200);
      expect(res.body.username).toMatch(/^demo-[0-9a-f]{8}$/);
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies).toBeDefined();
      expect(cookies.some((c) => c.startsWith('session=') && c.includes('HttpOnly'))).toBe(true);

      const list = await agent.get('/api/transactions');
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(5);
      const categories = list.body.map(
        (entry: { transaction: { category: string } }) => entry.transaction.category,
      );
      // Sorted by date ascending: salary (period start), groceries (-03),
      // dining (-07), groceries (-10), transport (-15) -- see seedDemoAccount.
      expect(categories).toEqual(['salary', 'groceries', 'dining', 'groceries', 'transport']);
      const salary = list.body.find(
        (entry: { transaction: { category: string } }) => entry.transaction.category === 'salary',
      );
      expect(salary.transaction).toMatchObject({ kind: 'income', amountMinor: 240000 });
      const dining = list.body.find(
        (entry: { transaction: { category: string } }) => entry.transaction.category === 'dining',
      );
      expect(dining.transaction).toMatchObject({ kind: 'expense', amountMinor: 2790 });
    });

    it('sweeps a stale demo account file but keeps a fresh one', async () => {
      const staleUsername = 'demo-deadbeef';
      const freshUsername = 'demo-cafebabe';
      const staleFile = join(dataDir, `${staleUsername}.json`);
      const freshFile = join(dataDir, `${freshUsername}.json`);
      await writeFile(staleFile, JSON.stringify(emptyStore()), 'utf-8');
      await writeFile(freshFile, JSON.stringify(emptyStore()), 'utf-8');

      // Backdate the stale file's mtime past the (small, test-only) TTL below.
      const longAgo = new Date(Date.now() - 60_000);
      await utimes(staleFile, longAgo, longAgo);

      const sweepingApp = createApp({
        dataDir,
        credentials: [{ username: 'antonio', passwordHash }],
        sessionSecret: 'test-secret',
        insecureCookies: true,
        demoAccountTtlMs: 1_000,
      });

      const res = await request(sweepingApp).post('/api/demo');
      expect(res.status).toBe(200);

      await expect(access(staleFile)).rejects.toThrow();
      await expect(access(freshFile)).resolves.toBeUndefined();
    });

    it('never sweeps a real (non-demo-shaped) user store file, even one older than the TTL', async () => {
      // Regression test for Socrates's finding 1: the sweep filters every
      // entry through DEMO_FILENAME_PATTERN before ever stat-ing/unlinking
      // it, so a real user's store file -- which never matches
      // `demo-<8 hex>.json` -- structurally cannot be touched by it,
      // regardless of age. If that filename check were ever loosened to
      // match everything in dataDir, this file would get swept and this
      // assertion would fail.
      const realUserFile = join(dataDir, 'some-real-user.json');
      await writeFile(realUserFile, JSON.stringify(emptyStore()), 'utf-8');
      const longAgo = new Date(Date.now() - 60_000);
      await utimes(realUserFile, longAgo, longAgo);

      const sweepingApp = createApp({
        dataDir,
        credentials: [{ username: 'antonio', passwordHash }],
        sessionSecret: 'test-secret',
        insecureCookies: true,
        demoAccountTtlMs: 1_000,
      });

      const res = await request(sweepingApp).post('/api/demo');
      expect(res.status).toBe(200);

      await expect(access(realUserFile)).resolves.toBeUndefined();
    });

    it('caps total concurrent demo accounts and returns 503 once the cap is reached', async () => {
      const cappedApp = createApp({
        dataDir,
        credentials: [{ username: 'antonio', passwordHash }],
        sessionSecret: 'test-secret',
        insecureCookies: true,
        demoAccountCap: 2,
      });

      for (let i = 0; i < 2; i += 1) {
        const res = await request(cappedApp).post('/api/demo');
        expect(res.status).toBe(200);
      }

      const capped = await request(cappedApp).post('/api/demo');
      expect(capped.status).toBe(503);
      expect(capped.body).toEqual({
        error: 'demo accounts are temporarily unavailable, try again later',
      });
    });

    it('rate-limits repeated /api/demo requests from the same IP', async () => {
      const limitedApp = createApp({
        dataDir,
        credentials: [{ username: 'antonio', passwordHash }],
        sessionSecret: 'test-secret',
        insecureCookies: true,
        demoRateLimit: { windowMs: 60_000, max: 2 },
      });

      const agent = request.agent(limitedApp);
      for (let i = 0; i < 2; i += 1) {
        const res = await agent.post('/api/demo');
        expect(res.status).toBe(200);
      }

      const limited = await agent.post('/api/demo');
      expect(limited.status).toBe(429);
    });
  });
});
