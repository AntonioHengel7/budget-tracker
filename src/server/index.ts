#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { CredentialsConfigError, loadCredentials } from './credentials.js';
import type { Credential } from './credentials.js';

const DEFAULT_PORT = 8080;
const DEFAULT_DATA_DIR = 'data';
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * Default reverse-proxy hop count trusted for client IP resolution
 * (`X-Forwarded-For`). This app is only ever planned to be deployed behind
 * Fly.io's edge, which is a single hop (see the locked hosting decision in
 * docs/plans/2026-08-14-web-ui.md) -- override via `TRUST_PROXY` for a
 * different topology (e.g. `0` for a direct, unproxied connection).
 */
const DEFAULT_TRUST_PROXY = 1;

/**
 * The minimum acceptable length for `SESSION_SECRET`. `session.ts` only
 * rejects an *empty* secret -- a short-but-nonempty secret is brute-forceable
 * against the HMAC, so this boot-time check closes that gap (see #17,
 * carried over from #16's review).
 */
const MIN_SESSION_SECRET_LENGTH = 32;

function readEnv(name: string): string | undefined {
  return process.env[name];
}

function parsePort(raw: string | undefined): number {
  const value = raw ?? String(DEFAULT_PORT);
  const port = Number(value);
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error(`PORT must be an integer between ${MIN_PORT} and ${MAX_PORT} (got ${JSON.stringify(value)})`);
  }
  return port;
}

function parseTrustProxy(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_TRUST_PROXY;
  }
  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`TRUST_PROXY must be a non-negative integer hop count (got ${JSON.stringify(raw)})`);
  }
  return hops;
}

export interface Booted {
  readonly app: ReturnType<typeof createApp>;
  readonly port: number;
}

/**
 * Validates all required configuration and builds the app, but does not
 * start listening -- callers decide when (and whether) to accept
 * connections. Throws synchronously on any misconfiguration (including an
 * out-of-range/non-numeric `PORT`), so the process fails fast at boot rather
 * than on the first request or inside `listen()`.
 */
export function boot(): Booted {
  const sessionSecret = readEnv('SESSION_SECRET');
  if (sessionSecret === undefined || sessionSecret === '') {
    throw new Error('SESSION_SECRET is not set');
  }
  if (sessionSecret.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters (got ${sessionSecret.length})`,
    );
  }

  let credentials: Credential[];
  try {
    credentials = loadCredentials(readEnv('AUTH_USERS_JSON'));
  } catch (err) {
    if (err instanceof CredentialsConfigError) {
      throw new Error(`Invalid AUTH_USERS_JSON: ${err.message}`);
    }
    throw err;
  }

  const dataDir = readEnv('DATA_DIR') ?? DEFAULT_DATA_DIR;
  const port = parsePort(readEnv('PORT'));
  const trustProxy = parseTrustProxy(readEnv('TRUST_PROXY'));
  const insecureCookies = readEnv('INSECURE_COOKIES') === 'true';
  // Optional: the directory containing the built frontend (`web/dist` in a
  // single-container deploy). Left undefined when unset, matching
  // `AppConfig.staticDir?` -- `createApp` simply serves API-only in that case.
  const staticDir = readEnv('STATIC_DIR');

  const app = createApp({
    dataDir,
    credentials,
    sessionSecret,
    trustProxy,
    insecureCookies,
    ...(staticDir !== undefined ? { staticDir } : {}),
  });

  return { app, port };
}

function main(): void {
  let booted: Booted;
  try {
    booted = boot();
  } catch (err) {
    console.error(`budget-tracker server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  booted.app.listen(booted.port, () => {
    console.log(`budget-tracker server listening on port ${booted.port}`);
  });
}

// Only run `main()` -- which can call `process.exit()` -- when this module is
// the actual entrypoint (`node dist/server/index.js`), not when it's
// imported (e.g. by tests importing `boot` for direct testing).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
