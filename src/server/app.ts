import { join } from 'node:path';
import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { addTransaction } from '../cli/commands/add.js';
import type { AddOptions } from '../cli/commands/add.js';
import { removeTransaction } from '../cli/commands/rm.js';
import { listTransactions } from '../cli/commands/list.js';
import type { ListOptions } from '../cli/commands/list.js';
import { setLimit } from '../cli/commands/limit.js';
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

export interface LoginRateLimitConfig {
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
  readonly loginRateLimit?: LoginRateLimitConfig;
  /**
   * Opts the session cookie out of the `Secure` flag, for local plaintext-HTTP
   * development only. Defaults to `false` -- cookies are `Secure` by default
   * and this must be explicitly enabled, never the reverse, so a deployment
   * that forgets to configure anything still ships a secure cookie.
   */
  readonly insecureCookies?: boolean;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimitConfig = {
  windowMs: 15 * 60 * 1000,
  max: 10,
};

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

function isBodyParserSyntaxError(
  err: unknown,
): err is SyntaxError & { status?: number; type?: string } {
  return err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed';
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
  app.use(express.json());
  app.use(cookieParser());

  app.get('/healthz', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

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
