import { mkdtemp, readFile, rm, writeFile, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    try {
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
    } finally {
      await rm(tmpWeb, { recursive: true, force: true });
    }
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

  // Regression (#95): a malformed percent-escape in a route param (e.g.
  // %zz, which decodeURIComponent cannot decode) makes Express's own
  // decodeParam step throw a URIError with .status = 400 before any route
  // handler runs -- this used to fall through the error middleware's
  // generic branch and surface as a 500, hiding a client-caused bad request
  // behind a server-error status.
  it('rejects a malformed percent-escaped route param with a 400, not a 500', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ username: 'antonio', password: PASSWORD });

    const res = await agent.delete('/api/limits/%zz');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'malformed request path' });
  });

  it('rejects a malformed percent-escaped transaction id route param with a 400, not a 500', async () => {
    const agent = request.agent(app);
    await agent.post('/api/login').send({ username: 'antonio', password: PASSWORD });

    const res = await agent.delete('/api/transactions/%zz');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'malformed request path' });
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

  // #76: no Content-Security-Policy/X-Frame-Options, and X-Powered-By still
  // on the wire. Asserted on an actual /api route and, separately, on the
  // static/SPA-served path -- headers come from helmet as the very first
  // middleware in createApp, so they must apply uniformly regardless of
  // route or response status.
  describe('security headers', () => {
    it('sets a strict CSP with no unsafe-inline/unsafe-eval, X-Frame-Options: DENY, and no X-Powered-By on an API route', async () => {
      const res = await request(app).get('/api/me');

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);

      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('applies the same security headers on the static/SPA-served path', async () => {
      const tmpWeb = await mkdtemp(join(tmpdir(), 'budget-web-headers-test-'));
      try {
        await writeFile(join(tmpWeb, 'index.html'), '<!doctype html><title>t</title>');
        const staticApp = createApp({
          dataDir,
          credentials: [{ username: 'antonio', passwordHash }],
          sessionSecret: 'test-secret',
          staticDir: tmpWeb,
        });

        const page = await request(staticApp).get('/some/client/route');
        expect(page.status).toBe(200);

        const csp = page.headers['content-security-policy'];
        expect(csp).toBeDefined();
        expect(csp).toContain("script-src 'self'");
        expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);

        expect(page.headers['x-frame-options']).toBe('DENY');
        expect(page.headers['x-powered-by']).toBeUndefined();
      } finally {
        await rm(tmpWeb, { recursive: true, force: true });
      }
    });

    // Regression (#96): font-src previously fell through to helmet's default
    // (`'self' https: data:`), which is broader than this app needs -- it
    // loads zero external fonts. Pinned to the actual header content, not
    // just "the app boots", so narrowing this back down is caught.
    it('sets a narrow font-src (no https:/data: fallback) since this app loads no external fonts', async () => {
      const res = await request(app).get('/api/me');

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("font-src 'self'");
      expect(csp).not.toMatch(/font-src[^;]*https:/);
      expect(csp).not.toMatch(/font-src[^;]*data:/);
    });

    // Regression (#96): frame-ancestors 'none' and upgradeInsecureRequests:
    // null in the helmet config previously had no test pinning them --
    // deleting either config line left every existing test green (they only
    // ever checked script-src/x-frame-options/x-powered-by). Assert the
    // actual header content so a revert of either line is caught here.
    it('sets frame-ancestors \'none\' in the CSP (stricter than helmet\'s own default of \'self\')', async () => {
      const res = await request(app).get('/api/me');

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      expect(csp).toContain("frame-ancestors 'none'");
    });

    it('omits upgrade-insecure-requests from the CSP, so local plaintext-HTTP dev is never forced to HTTPS', async () => {
      const res = await request(app).get('/api/me');

      const csp = res.headers['content-security-policy'];
      expect(csp).toBeDefined();
      // helmet includes this directive by default; only an explicit `null`
      // override (see createApp's helmet config) removes it entirely.
      expect(csp).not.toMatch(/upgrade-insecure-requests/);
    });
  });

  // #104: self-service signup with email verification.
  describe('self-service signup', () => {
    function createSignupApp(
      signupOverrides: Record<string, unknown> = {},
      sendEmail: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
    ): { signupApp: ReturnType<typeof createApp>; sendEmail: ReturnType<typeof vi.fn> } {
      const signupApp = createApp({
        dataDir,
        credentials: [{ username: 'antonio', passwordHash }],
        sessionSecret: 'test-secret',
        insecureCookies: true,
        signup: {
          fromAddress: 'noreply@example.com',
          publicAppUrl: 'https://budget.example.com',
          sendEmail,
          ...signupOverrides,
        },
      });
      return { signupApp, sendEmail };
    }

    function extractVerifyLink(sendEmail: ReturnType<typeof vi.fn>): { username: string; token: string } {
      const call = sendEmail.mock.calls[0]?.[0] as { html: string } | undefined;
      expect(call).toBeDefined();
      const match = /href="([^"]+)"/.exec(call?.html ?? '');
      expect(match).not.toBeNull();
      const url = new URL(match?.[1] ?? '');
      const username = url.searchParams.get('username');
      const token = url.searchParams.get('token');
      expect(username).not.toBeNull();
      expect(token).not.toBeNull();
      return { username: username ?? '', token: token ?? '' };
    }

    it('responds 503 for /api/signup and /api/verify when config.signup is undefined', async () => {
      const signupRes = await request(app)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      expect(signupRes.status).toBe(503);
      expect(signupRes.body).toEqual({ error: 'self-service signup is not enabled' });

      const verifyRes = await request(app).post('/api/verify').send({ username: 'newuser', token: 'x' });
      expect(verifyRes.status).toBe(503);
      expect(verifyRes.body).toEqual({ error: 'self-service signup is not enabled' });
    });

    it('leaves /api/login byte-for-byte identical (still a plain 401) for an unknown user when signup is disabled', async () => {
      const res = await request(app).post('/api/login').send({ username: 'nobody', password: 'whatever' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid credentials' });
    });

    it('falls through to the generic 401 for a malformed username on /api/login when signup is enabled, instead of a 400 echoing the raw input', async () => {
      const { signupApp } = createSignupApp();
      const res = await request(signupApp)
        .post('/api/login')
        .send({ username: '../../etc/passwd', password: 'whatever' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid credentials' });
    });

    it('signup happy path: creates an unverified record and sends a verification email', async () => {
      const { signupApp, sendEmail } = createSignupApp();
      const res = await request(signupApp).post('/api/signup').send({
        username: 'newuser',
        email: 'New.User@Example.com',
        password: 'longenoughpassword',
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'check your email to verify your account' });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const emailArgs = sendEmail.mock.calls[0]?.[0] as { to: string; subject: string };
      expect(emailArgs.to).toBe('new.user@example.com');
      expect(emailArgs.subject).toBe('Verify your budget-tracker account');

      const stored = JSON.parse(await readFile(join(dataDir, 'signups', 'newuser.json'), 'utf-8'));
      expect(stored.verified).toBe(false);
      expect(stored.email).toBe('new.user@example.com');
      expect(stored.passwordHash).not.toBe('longenoughpassword');
    });

    it('rejects a duplicate username against AUTH_USERS_JSON with 409', async () => {
      const { signupApp } = createSignupApp();
      const res = await request(signupApp).post('/api/signup').send({
        username: 'antonio',
        email: 'other@example.com',
        password: 'longenoughpassword',
      });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'username already taken' });
    });

    it('rejects a duplicate username against an already-verified signup with 409', async () => {
      const { signupApp, sendEmail } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      const { username, token } = extractVerifyLink(sendEmail);
      await request(signupApp).post('/api/verify').send({ username, token });

      const res = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'b@example.com', password: 'longenoughpassword' });
      expect(res.status).toBe(409);
    });

    it('responds with the identical success message for a duplicate email, writing no file and sending no email', async () => {
      const { signupApp, sendEmail } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'first', email: 'shared@example.com', password: 'longenoughpassword' });
      sendEmail.mockClear();

      const res = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'second', email: 'shared@example.com', password: 'longenoughpassword' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ message: 'check your email to verify your account' });
      expect(sendEmail).not.toHaveBeenCalled();
      await expect(access(join(dataDir, 'signups', 'second.json'))).rejects.toThrow();
    });

    it('returns 503 once the unverified-signup cap is reached', async () => {
      const { signupApp } = createSignupApp({ unverifiedCap: 1 });
      const first = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'first', email: 'first@example.com', password: 'longenoughpassword' });
      expect(first.status).toBe(200);

      const second = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'second', email: 'second@example.com', password: 'longenoughpassword' });
      expect(second.status).toBe(503);
      expect(second.body).toEqual({ error: 'signups are temporarily unavailable, try again later' });
    });

    it('a resend/retry for the same unverified username and same email overwrites the record without counting against the cap', async () => {
      const { signupApp, sendEmail } = createSignupApp({ unverifiedCap: 1 });
      const first = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'first@example.com', password: 'longenoughpassword' });
      expect(first.status).toBe(200);

      const resend = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'first@example.com', password: 'longenoughpassword' });
      expect(resend.status).toBe(200);
      expect(sendEmail).toHaveBeenCalledTimes(2);

      const stored = JSON.parse(await readFile(join(dataDir, 'signups', 'newuser.json'), 'utf-8'));
      expect(stored.email).toBe('first@example.com');
    });

    it('rejects a signup for an existing unverified username with a DIFFERENT email with 409, sends no email, and leaves the original record untouched', async () => {
      const { signupApp, sendEmail } = createSignupApp({ unverifiedCap: 1 });
      const first = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'victim', email: 'victim@example.com', password: 'victimpassword' });
      expect(first.status).toBe(200);
      const original = JSON.parse(await readFile(join(dataDir, 'signups', 'victim.json'), 'utf-8'));
      sendEmail.mockClear();

      // An attacker who knows the victim's pending username, but not their
      // email, must not be able to hijack the record by posting their own
      // email -- this must return the same generic 409 every other
      // collision case gets, not a distinct response (see #105).
      const attack = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'victim', email: 'attacker@evil.com', password: 'attackerpassword' });
      expect(attack.status).toBe(409);
      expect(attack.body).toEqual({ error: 'username already taken' });
      expect(sendEmail).not.toHaveBeenCalled();

      const stored = JSON.parse(await readFile(join(dataDir, 'signups', 'victim.json'), 'utf-8'));
      expect(stored.email).toBe(original.email);
      expect(stored.passwordHash).toBe(original.passwordHash);
      expect(stored.verificationTokenHash).toBe(original.verificationTokenHash);
    });

    it('verify happy path: flips the record to verified and allows login afterward', async () => {
      const { signupApp, sendEmail } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      const { username, token } = extractVerifyLink(sendEmail);

      const verifyRes = await request(signupApp).post('/api/verify').send({ username, token });
      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body).toEqual({ message: 'verified', username: 'newuser' });

      const loginRes = await request(signupApp)
        .post('/api/login')
        .send({ username: 'newuser', password: 'longenoughpassword' });
      expect(loginRes.status).toBe(200);
      expect(loginRes.body).toEqual({ username: 'newuser' });
      const cookies = loginRes.headers['set-cookie'] as unknown as string[];
      expect(cookies.some((c) => c.startsWith('session=') && c.includes('HttpOnly'))).toBe(true);
    });

    it('is idempotent on an already-verified account', async () => {
      const { signupApp, sendEmail } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      const { username, token } = extractVerifyLink(sendEmail);
      await request(signupApp).post('/api/verify').send({ username, token });

      const secondClick = await request(signupApp).post('/api/verify').send({ username, token });
      expect(secondClick.status).toBe(200);
      expect(secondClick.body).toEqual({ message: 'already verified', username: 'newuser' });
    });

    it('rejects an expired verification token with 400', async () => {
      const { signupApp, sendEmail } = createSignupApp({ tokenTtlMs: 1 });
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      const { username, token } = extractVerifyLink(sendEmail);

      await new Promise((resolve) => setTimeout(resolve, 20));

      const res = await request(signupApp).post('/api/verify').send({ username, token });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid or expired verification link' });
    });

    it('rejects a wrong verification token with 400', async () => {
      const { signupApp, sendEmail } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      const { username } = extractVerifyLink(sendEmail);

      const res = await request(signupApp).post('/api/verify').send({ username, token: 'not-the-right-token' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid or expired verification link' });
    });

    it('rejects verification for an unknown username with 400', async () => {
      const { signupApp } = createSignupApp();
      const res = await request(signupApp).post('/api/verify').send({ username: 'nobody', token: 'whatever' });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'invalid or expired verification link' });
    });

    it('login responds 403 for an unverified account and sets no session cookie', async () => {
      const { signupApp } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });

      const res = await request(signupApp)
        .post('/api/login')
        .send({ username: 'newuser', password: 'longenoughpassword' });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'please verify your email before logging in' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('login responds with the generic 401 (not the 403 unverified hint) for an unverified account given the WRONG password -- must not disclose pending-account existence without password knowledge', async () => {
      const { signupApp } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });

      const res = await request(signupApp)
        .post('/api/login')
        .send({ username: 'newuser', password: 'totally wrong' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid credentials' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('login falls through to the generic 401 for a signup account given the wrong password', async () => {
      const { signupApp, sendEmail } = createSignupApp();
      await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      const { username, token } = extractVerifyLink(sendEmail);
      await request(signupApp).post('/api/verify').send({ username, token });

      const res = await request(signupApp).post('/api/login').send({ username: 'newuser', password: 'wrong' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'invalid credentials' });
    });

    it('rejects a username starting with the reserved demo- prefix', async () => {
      const { signupApp } = createSignupApp();
      const res = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'demo-abc', email: 'a@example.com', password: 'longenoughpassword' });
      expect(res.status).toBe(400);
    });

    it('rejects a password shorter than 8 characters', async () => {
      const { signupApp } = createSignupApp();
      const res = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'short' });
      expect(res.status).toBe(400);
    });

    it('rejects a malformed email address', async () => {
      const { signupApp } = createSignupApp();
      const res = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'not-an-email', password: 'longenoughpassword' });
      expect(res.status).toBe(400);
    });

    it('rejects signup for a username that already has a budget data file', async () => {
      await writeFile(join(dataDir, 'orphan.json'), JSON.stringify(emptyStore()), 'utf-8');
      const { signupApp } = createSignupApp();
      const res = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'orphan', email: 'a@example.com', password: 'longenoughpassword' });
      expect(res.status).toBe(409);
    });

    it('rate-limits repeated /api/signup requests from the same IP', async () => {
      const { signupApp } = createSignupApp({ rateLimit: { windowMs: 60_000, max: 2 } });
      const agent = request.agent(signupApp);
      for (let i = 0; i < 2; i += 1) {
        const res = await agent
          .post('/api/signup')
          .send({ username: `user${i}`, email: `user${i}@example.com`, password: 'longenoughpassword' });
        expect(res.status).toBe(200);
      }
      const limited = await agent
        .post('/api/signup')
        .send({ username: 'user3', email: 'user3@example.com', password: 'longenoughpassword' });
      expect(limited.status).toBe(429);
    });

    it('maps a sendEmail failure to a 500, not an unhandled rejection', async () => {
      const { signupApp } = createSignupApp({}, vi.fn().mockRejectedValue(new Error('resend is down')));

      const res = await request(signupApp)
        .post('/api/signup')
        .send({ username: 'newuser', email: 'a@example.com', password: 'longenoughpassword' });
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'internal server error' });
    });
  });
});
