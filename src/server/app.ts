import { randomBytes } from 'node:crypto';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { addTransaction } from '../cli/commands/add.js';
import type { AddOptions } from '../cli/commands/add.js';
import { removeTransaction } from '../cli/commands/rm.js';
import { listTransactions } from '../cli/commands/list.js';
import type { ListOptions } from '../cli/commands/list.js';
import { removeLimit, setLimit } from '../cli/commands/limit.js';
import type { SetLimitOptions } from '../cli/commands/limit.js';
import { getStatus } from '../cli/commands/status.js';
import { getSummary } from '../cli/commands/summary.js';
import { todayIsoDate, currentPeriod } from '../shared/clock.js';
import { DomainError } from '../domain/errors.js';
import { StorageError } from '../storage/jsonStore.js';
import { authenticate } from './credentials.js';
import type { Credential } from './credentials.js';
import { resolveUserStorePath } from './paths.js';
import { signSession } from './session.js';
import { createAuthMiddleware, isAuthenticatedRequest } from './authMiddleware.js';
import type { AuthenticatedRequest } from './authMiddleware.js';

/** Shape shared by every `express-rate-limit` config knob this app exposes. */
export interface RateLimitConfig {
  readonly windowMs: number;
  readonly max: number;
}

export interface AppConfig {
  readonly dataDir: string;
  readonly credentials: Credential[];
  readonly sessionSecret: string;
  /** When set, serves this directory as the built frontend, with a SPA fallback for non-API routes. */
  readonly staticDir?: string;
  /**
   * Number of reverse-proxy hops to trust for client IP resolution
   * (`X-Forwarded-For`), passed straight to Express's `trust proxy` setting.
   * Defaults to `0` -- trust nobody, resolve the client IP from the raw
   * socket only. This is the safe default for direct connections and tests;
   * a deployment that sits behind a real reverse proxy (e.g. Fly.io) must
   * pass the exact hop count explicitly. Never pass `true` here -- that
   * trusts every hop in the chain and lets a client spoof its own IP via a
   * forged `X-Forwarded-For` header, defeating IP-based rate limiting.
   */
  readonly trustProxy?: number;
  /** Overrides the default login rate limit -- mainly so tests don't need to wait out a real 15-minute window. */
  readonly loginRateLimit?: RateLimitConfig;
  /**
   * Overrides the default general `/api/*` rate limit -- mainly so tests
   * don't need to wait out a real 1-minute window. Applies to every `/api/*`
   * route, stacked on top of (not instead of) `loginRateLimit` for
   * `/api/login`, which stays tighter.
   */
  readonly apiRateLimit?: RateLimitConfig;
  /**
   * Overrides the default `/api/demo` rate limit -- mainly so tests don't
   * need to wait out a real 1-hour window.
   */
  readonly demoRateLimit?: RateLimitConfig;
  /**
   * Overrides how long a demo account is allowed to live before the sweep in
   * `/api/demo` deletes its store file -- mainly so tests don't need to wait
   * out a real 24-hour TTL.
   */
  readonly demoAccountTtlMs?: number;
  /**
   * Overrides the default cap on total concurrent demo accounts -- mainly so
   * tests don't need to create hundreds of accounts to exercise the cap.
   */
  readonly demoAccountCap?: number;
  /**
   * Opts the session cookie out of the `Secure` flag, for local plaintext-HTTP
   * development only. Defaults to `false` -- cookies are `Secure` by default
   * and this must be explicitly enabled, never the reverse, so a deployment
   * that forgets to configure anything still ships a secure cookie.
   */
  readonly insecureCookies?: boolean;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_RATE_LIMIT: RateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 10,
};
/**
 * General `/api/*` rate limit, applied uniformly to every API route
 * (including `/api/login`, stacked on top of its own tighter limit above).
 * Unlike login attempts, normal single-user traffic legitimately re-hits
 * status/summary/list endpoints often (e.g. a dashboard that refreshes or a
 * user paging through transactions), so this needs to be generous enough
 * that the real user never notices it -- 120 requests/minute is ~2 req/s
 * sustained, well above any real interactive usage pattern, while still
 * meaningfully throttling a scripted hammering attempt against a
 * usage-billed machine.
 */
const DEFAULT_API_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 1000,
  max: 120,
};
/**
 * Each `/api/demo` call writes a brand-new store file to disk, so this is a
 * resource-exhaustion guard first and foremost, not a credential-stuffing
 * guard like `DEFAULT_LOGIN_RATE_LIMIT` -- 5 demo accounts/hour/IP is
 * generous for a human trying the product out, while meaningfully slowing
 * a single scripted caller. On its own this does not bound total disk
 * usage -- a caller spread across many source IPs isn't slowed by a
 * per-IP limit at all -- that's what `DEFAULT_DEMO_ACCOUNT_CAP` below is
 * for.
 */
const DEFAULT_DEMO_RATE_LIMIT: RateLimitConfig = {
  windowMs: 60 * 60 * 1000,
  max: 5,
};
/** How long a demo account's store file is allowed to live before the sweep in `/api/demo` deletes it. */
const DEFAULT_DEMO_ACCOUNT_TTL_MS = 24 * 60 * 60 * 1000;
/** Matches the filename shape produced by demo account generation below -- `demo-` plus 8 hex chars. */
const DEMO_FILENAME_PATTERN = /^demo-[0-9a-f]{8}\.json$/;
/**
 * Hard cap on how many demo accounts may exist at once, checked after each
 * sweep. This is what actually bounds disk/inode usage -- the per-IP rate
 * limit above only slows a single source, so without this cap a caller
 * spread across many IPs (or simply patient across the 24h TTL window)
 * could still accumulate an unbounded number of demo account files. 200 is
 * comfortably above any realistic resume/portfolio-traffic burst (the kind
 * of spike this feature exists for) while keeping worst-case disk usage to
 * a couple hundred small seeded store files.
 */
const DEFAULT_DEMO_ACCOUNT_CAP = 200;
/** Max attempts to generate a demo username before giving up (see `/api/demo` below). */
const MAX_DEMO_USERNAME_ATTEMPTS = 5;

function sessionCookieOptions(config: AppConfig): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: !config.insecureCookies,
    path: '/',
  };
}

/** Reads `body[key]` as a string, or `undefined` if absent/not a string. */
function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Reads `body[key]` as a boolean, or `undefined` if absent/not a boolean. */
function booleanField(body: unknown, key: string): boolean | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** Reads `query[key]` as a string, or `undefined` if absent/not a plain string. */
function queryString(query: Request['query'], key: string): string | undefined {
  const value = query[key];
  return typeof value === 'string' ? value : undefined;
}

function buildListOptions(query: Request['query']): ListOptions {
  const from = queryString(query, 'from');
  const to = queryString(query, 'to');
  const category = queryString(query, 'category');
  const kind = queryString(query, 'kind');
  const note = queryString(query, 'note');
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

type AuthenticatedHandler = (req: AuthenticatedRequest, res: Response) => Promise<void> | void;

/**
 * Wraps a handler that requires an authenticated request. Every route
 * registered on `api` below runs behind `authMiddleware` first, which either
 * responds 401 or sets `req.username` from a verified session -- so by the
 * time an `authed` handler runs, `isAuthenticatedRequest` is guaranteed true.
 * This is the one place a `Request` is narrowed (never cast) into an
 * `AuthenticatedRequest`; the `next(err)` branch below is unreachable in
 * practice and exists only as a defensive fallback against a future wiring
 * mistake (e.g. a route added to `api` before `api.use(authMiddleware)`).
 */
function authed(handler: AuthenticatedHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isAuthenticatedRequest(req)) {
      next(new Error('protected route reached without an authenticated request'));
      return;
    }
    Promise.resolve(handler(req, res)).catch(next);
  };
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Best-effort deletion of expired demo account store files, and returns how
 * many demo account files remain afterward (the caller uses this to enforce
 * `DEFAULT_DEMO_ACCOUNT_CAP`). Runs on every `/api/demo` call, before a new
 * demo account is issued, so demo accounts self-clean without needing a
 * separate cron/scheduler process. Never throws -- a sweep failure (e.g. a
 * transient permission error, or `dataDir` not existing yet) must never
 * block issuing a new demo account, so every error here (including
 * `readdir` ENOENT on a not-yet-created `dataDir`) is swallowed and simply
 * treated as "nothing to sweep".
 */
async function sweepStaleDemoAccounts(dataDir: string, ttlMs: number): Promise<number> {
  try {
    const entries = await readdir(dataDir);
    const now = Date.now();
    let survivingCount = 0;
    for (const entry of entries) {
      if (!DEMO_FILENAME_PATTERN.test(entry)) {
        continue;
      }
      const filePath = join(dataDir, entry);
      try {
        const stats = await stat(filePath);
        if (now - stats.mtimeMs > ttlMs) {
          await unlink(filePath);
        } else {
          survivingCount += 1;
        }
      } catch {
        // A single file's stat/unlink failing (e.g. it was removed by a
        // concurrent sweep, or a transient FS error) must not abort the
        // sweep for every other file -- skip it and keep going. Its
        // survival is unknown, so it's not counted either way.
      }
    }
    return survivingCount;
  } catch {
    // Covers readdir failing outright (missing dataDir, permission error,
    // ...) -- treated the same as "nothing to sweep", per this function's doc
    // comment above.
    return 0;
  }
}

/**
 * Generates an unused `demo-<8 hex chars>` username, matching
 * `USERNAME_PATTERN` in `paths.ts`. Collisions are astronomically unlikely
 * (1 in 2^32 per attempt) but checked for anyway rather than assumed away --
 * retries up to `MAX_DEMO_USERNAME_ATTEMPTS` times before giving up.
 */
async function generateDemoUsername(dataDir: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < MAX_DEMO_USERNAME_ATTEMPTS; attempt += 1) {
    const username = `demo-${randomBytes(4).toString('hex')}`;
    const filePath = resolveUserStorePath(dataDir, username);
    try {
      await stat(filePath);
      // File exists -- collision, retry.
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        return username;
      }
      throw err;
    }
  }
  return undefined;
}

/**
 * Seeds a freshly created demo account's store with a small, realistic
 * dataset: one income transaction, four expense transactions spread across
 * groceries/dining/transport, and category limits chosen so groceries reads
 * "under" its limit and dining reads "over" -- demonstrating both status
 * colors (`.status-over`/`.status-under` in `web/src/index.css`) without
 * requiring any manual setup from whoever clicks "try it out".
 */
async function seedDemoAccount(filePath: string): Promise<void> {
  const period = currentPeriod();
  const periodStart = `${period}-01`;

  await addTransaction(filePath, {
    amount: '2400.00',
    category: 'salary',
    kind: 'income',
    date: periodStart,
  });
  await addTransaction(filePath, {
    amount: '64.50',
    category: 'groceries',
    kind: 'expense',
    date: `${period}-03`,
    note: "Trader Joe's",
  });
  await addTransaction(filePath, {
    amount: '38.20',
    category: 'groceries',
    kind: 'expense',
    date: `${period}-10`,
    note: 'Weekly grocery run',
  });
  await addTransaction(filePath, {
    amount: '27.90',
    category: 'dining',
    kind: 'expense',
    date: `${period}-07`,
    note: 'Lunch with a friend',
  });
  await addTransaction(filePath, {
    amount: '45.00',
    category: 'transport',
    kind: 'expense',
    date: `${period}-15`,
    note: 'Gas',
  });

  // groceries: spent 64.50 + 38.20 = 102.70 against a 150.00 limit -> under.
  await setLimit(filePath, { category: 'groceries', amount: '150.00', effectiveFrom: period });
  // dining: spent 27.90 against a 25.00 limit -> over.
  await setLimit(filePath, { category: 'dining', amount: '25.00', effectiveFrom: period });
}

function isBodyParserSyntaxError(
  err: unknown,
): err is SyntaxError & { status?: number; type?: string } {
  return err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed';
}

/**
 * `express.json()`'s size limit rejects an oversized body with an
 * `http-errors`-shaped `PayloadTooLargeError` (not a `SyntaxError`) -- a
 * plain `Error` with `.type === 'entity.too.large'` and `.status`/
 * `.statusCode === 413`, thrown by `raw-body` before the JSON parser ever
 * runs. Checked purely by `.type` (like `isBodyParserSyntaxError` above)
 * rather than by `instanceof`, since `http-errors` doesn't export a distinct
 * class for it.
 */
function isBodyParserPayloadTooLargeError(
  err: unknown,
): err is Error & { status?: number; type?: string } {
  return err instanceof Error && (err as { type?: string }).type === 'entity.too.large';
}

/**
 * Builds the Express app. Every data-touching route resolves the per-user
 * store path from `req.username` (set by the auth middleware from the
 * verified session cookie) -- never from client-supplied request body/query
 * fields -- so a request can never read or write another user's data.
 */
export function createApp(config: AppConfig): Express {
  const app = express();
  app.set('trust proxy', config.trustProxy ?? 0);

  // Registered before every other middleware/route (including /healthz) so
  // its response headers -- CSP, X-Frame-Options, and disabling X-Powered-By
  // -- apply uniformly to every response this app ever sends. See #76.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // helmet's defaults already give `script-src 'self'` and
          // `object-src 'none'` with no 'unsafe-inline'/'unsafe-eval' --
          // kept as-is. `style-src` is narrowed below because helmet
          // defaults it to `'self' https: 'unsafe-inline'`, and this app
          // has no inline <style> tags or React inline `style` props left
          // (the one that existed was moved to a CSS class for #76) and no
          // external stylesheet host, so neither allowance is needed.
          styleSrc: ["'self'"],
          // Stricter than helmet's default `frame-ancestors 'self'` --
          // this app has no legitimate reason to ever be framed.
          frameAncestors: ["'none'"],
          // helmet includes this directive by default, which makes browsers
          // upgrade every subresource (and some, top-level navigation) to
          // HTTPS. This app explicitly supports local plaintext-HTTP dev
          // (see `insecureCookies` above) and forcing HTTPS there would
          // break it -- omitted rather than left on speculatively.
          upgradeInsecureRequests: null,
        },
      },
      // Same intent as `frame-ancestors 'none'` above, belt-and-suspenders
      // for browsers that only honor the legacy header.
      xFrameOptions: { action: 'deny' },
    }),
  );

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  // Registered before any /api route (and before the body parser below) so
  // it covers every /api route uniformly -- /api/login and /api/logout
  // (mounted directly below) as well as every route on the `api` sub-router
  // mounted further down -- and so a request that's about to be throttled
  // never pays the cost of a full JSON body read/parse first. /healthz above
  // is outside the /api prefix and is never subject to this (Fly's health
  // checks must never be throttled). The limiter is purely IP/route based
  // and never touches the body, so running it before express.json() changes
  // nothing about its behavior.
  const generalLimiter = rateLimit({
    windowMs: config.apiRateLimit?.windowMs ?? DEFAULT_API_RATE_LIMIT.windowMs,
    limit: config.apiRateLimit?.max ?? DEFAULT_API_RATE_LIMIT.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many requests, try again later' },
  });
  app.use('/api', generalLimiter);

  app.use(express.json());
  app.use(cookieParser());

  // Stacked on top of generalLimiter above: login attempts are much more
  // sensitive (credential-stuffing risk) than ordinary API traffic, so this
  // stays tighter and keeps /api/login at least as restrictive as before
  // this general limiter was introduced.
  const loginLimiter = rateLimit({
    windowMs: config.loginRateLimit?.windowMs ?? DEFAULT_LOGIN_RATE_LIMIT.windowMs,
    limit: config.loginRateLimit?.max ?? DEFAULT_LOGIN_RATE_LIMIT.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many login attempts, try again later' },
  });

  app.post('/api/login', loginLimiter, async (req: Request, res: Response) => {
    const username = stringField(req.body, 'username');
    const password: unknown =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)['password']
        : undefined;

    if (username === undefined) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    const ok = await authenticate(config.credentials, username, password);
    if (!ok) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    const token = signSession(username, config.sessionSecret);
    res.cookie('session', token, { ...sessionCookieOptions(config), maxAge: THIRTY_DAYS_MS });
    res.status(200).json({ username });
  });

  app.post('/api/logout', (_req: Request, res: Response) => {
    res.clearCookie('session', sessionCookieOptions(config));
    res.status(200).json({ ok: true });
  });

  // Stacked on top of generalLimiter above, same shape as loginLimiter --
  // see DEFAULT_DEMO_RATE_LIMIT's doc comment for why this exists (disk
  // resource exhaustion, not credential stuffing).
  const demoLimiter = rateLimit({
    windowMs: config.demoRateLimit?.windowMs ?? DEFAULT_DEMO_RATE_LIMIT.windowMs,
    limit: config.demoRateLimit?.max ?? DEFAULT_DEMO_RATE_LIMIT.max,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too many demo requests, try again later' },
  });

  // No try/catch here, matching /api/login above: Express 5 forwards a
  // rejected promise from an async handler to the error middleware at the
  // bottom of this file automatically (e.g. seedDemoAccount below throwing a
  // DomainError/StorageError), so an unhandled seed failure still ends up as
  // a clean 400/500 response rather than crashing the process.
  app.post('/api/demo', demoLimiter, async (_req: Request, res: Response) => {
    const survivingCount = await sweepStaleDemoAccounts(
      config.dataDir,
      config.demoAccountTtlMs ?? DEFAULT_DEMO_ACCOUNT_TTL_MS,
    );

    const cap = config.demoAccountCap ?? DEFAULT_DEMO_ACCOUNT_CAP;
    if (survivingCount >= cap) {
      res.status(503).json({ error: 'demo accounts are temporarily unavailable, try again later' });
      return;
    }

    const username = await generateDemoUsername(config.dataDir);
    if (username === undefined) {
      res.status(500).json({ error: 'could not allocate a demo account' });
      return;
    }

    const filePath = resolveUserStorePath(config.dataDir, username);
    await seedDemoAccount(filePath);

    const token = signSession(username, config.sessionSecret);
    res.cookie('session', token, { ...sessionCookieOptions(config), maxAge: THIRTY_DAYS_MS });
    res.status(200).json({ username });
  });

  const authMiddleware = createAuthMiddleware(config.sessionSecret);
  const api = express.Router();
  api.use(authMiddleware);

  api.get(
    '/me',
    authed((req, res) => {
      res.status(200).json({ username: req.username });
    }),
  );

  api.get(
    '/transactions',
    authed(async (req, res) => {
      const filePath = resolveUserStorePath(config.dataDir, req.username);
      const results = await listTransactions(filePath, buildListOptions(req.query));
      res.status(200).json(results);
    }),
  );

  api.post(
    '/transactions',
    authed(async (req, res) => {
      const amount = stringField(req.body, 'amount');
      const category = stringField(req.body, 'category');
      const kind = stringField(req.body, 'kind');
      const note = stringField(req.body, 'note');
      const date = stringField(req.body, 'date') ?? todayIsoDate();

      if (amount === undefined || category === undefined || kind === undefined) {
        res.status(400).json({ error: 'amount, category, and kind are required' });
        return;
      }

      const options: AddOptions = {
        amount,
        category,
        kind,
        date,
        ...(note !== undefined ? { note } : {}),
      };
      const filePath = resolveUserStorePath(config.dataDir, req.username);
      const result = await addTransaction(filePath, options);
      res.status(201).json(result);
    }),
  );

  api.delete(
    '/transactions/:id',
    authed(async (req, res) => {
      const id = req.params['id'];
      if (typeof id !== 'string') {
        res.status(400).json({ error: 'transaction id is required' });
        return;
      }
      const filePath = resolveUserStorePath(config.dataDir, req.username);
      const removed = await removeTransaction(filePath, id);
      res.status(200).json(removed);
    }),
  );

  api.put(
    '/limits',
    authed(async (req, res) => {
      const category = stringField(req.body, 'category');
      const amount = stringField(req.body, 'amount');
      const effectiveFrom = stringField(req.body, 'effectiveFrom');
      const rollover = booleanField(req.body, 'rollover');

      if (category === undefined || amount === undefined || effectiveFrom === undefined) {
        res.status(400).json({ error: 'category, amount, and effectiveFrom are required' });
        return;
      }

      const options: SetLimitOptions = {
        category,
        amount,
        effectiveFrom,
        ...(rollover !== undefined ? { rollover } : {}),
      };
      const filePath = resolveUserStorePath(config.dataDir, req.username);
      const budget = await setLimit(filePath, options);
      res.status(200).json(budget);
    }),
  );

  api.delete(
    '/limits/:category',
    authed(async (req, res) => {
      const category = req.params['category'];
      if (typeof category !== 'string') {
        res.status(400).json({ error: 'category is required' });
        return;
      }
      const filePath = resolveUserStorePath(config.dataDir, req.username);
      const removed = await removeLimit(filePath, category);
      res.status(200).json(removed);
    }),
  );

  api.get(
    '/status',
    authed(async (req, res) => {
      const period = queryString(req.query, 'period') ?? currentPeriod();
      const filePath = resolveUserStorePath(config.dataDir, req.username);
      const results = await getStatus(filePath, { period });
      res.status(200).json(results);
    }),
  );

  api.get(
    '/summary',
    authed(async (req, res) => {
      const period = queryString(req.query, 'period') ?? currentPeriod();
      const filePath = resolveUserStorePath(config.dataDir, req.username);
      const result = await getSummary(filePath, { period });
      res.status(200).json(result);
    }),
  );

  app.use('/api', api);

  const { staticDir } = config;
  if (staticDir !== undefined) {
    app.use(express.static(staticDir));
    // Any non-API path falls back to the SPA's index.html for client-side routing.
    app.get(/^\/(?!api\/).*/, (_req: Request, res: Response) => {
      res.sendFile(join(staticDir, 'index.html'));
    });
  }

  // Express 5 forwards rejected promises from async handlers to this error
  // middleware automatically; `authed` above forwards its handlers' the same
  // way explicitly, so every thrown/rejected error from a route ends up here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // A malformed JSON request body (e.g. hitting /api/login with garbage as
    // the body) surfaces here as body-parser's own SyntaxError -- respond
    // with a clean 400 and no stack trace, rather than falling through to
    // the generic 500 branch below.
    if (isBodyParserSyntaxError(err)) {
      res.status(400).json({ error: 'malformed JSON request body' });
      return;
    }

    // A request body exceeding express.json()'s size limit surfaces here as
    // body-parser's PayloadTooLargeError -- respond with the semantically
    // correct 413, rather than falling through to the generic 500 branch
    // below.
    if (isBodyParserPayloadTooLargeError(err)) {
      res.status(413).json({ error: 'request body too large' });
      return;
    }

    // DomainError is always client-caused (bad input, e.g. an unknown
    // transaction id or an invalid amount) -- its message is validation-shaped
    // and safe to echo back.
    if (err instanceof DomainError) {
      res.status(400).json({ error: err.message });
      return;
    }

    // StorageError is never the client's fault (a corrupted store file, a
    // filesystem permission error, ...) and its message can contain the
    // absolute data-directory path or raw OS error text -- log it server-side
    // only, and send the client a generic message under a 5xx status so it
    // isn't hidden from 5xx alerting.
    if (err instanceof StorageError) {
      console.error(`storage error: ${err.message}`);
      res.status(500).json({ error: 'internal server error' });
      return;
    }

    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
