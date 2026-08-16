import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/server/app.js';

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
});
