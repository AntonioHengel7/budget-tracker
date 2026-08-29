#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { CredentialsConfigError, loadCredentials } from './credentials.js';
import type { Credential } from './credentials.js';
import { createResendSender } from './email.js';

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

  // An explicitly empty DATA_DIR is treated the same as unset -- mirrors
  // both entrypoint.sh's `${DATA_DIR:-/data}` shell fallback (which also
  // treats "" as unset) and STATIC_DIR's "" handling below, so the app never
  // silently resolves an empty DATA_DIR to something other than the
  // container's actual data directory (see #37).
  const rawDataDir = readEnv('DATA_DIR');
  const dataDir = rawDataDir === undefined || rawDataDir === '' ? DEFAULT_DATA_DIR : rawDataDir;
  const port = parsePort(readEnv('PORT'));
  const trustProxy = parseTrustProxy(readEnv('TRUST_PROXY'));
  const insecureCookies = readEnv('INSECURE_COOKIES') === 'true';
  // Optional: the directory containing the built frontend (`web-dist` in the
  // single-container deploy image -- see the Dockerfile's runtime stage).
  // Left undefined when unset *or* explicitly set to "", matching
  // `AppConfig.staticDir?` -- `createApp` simply serves API-only in that
  // case. An empty string is treated the same as unset (not a real path),
  // consistent with how SESSION_SECRET rejects "" above.
  const rawStaticDir = readEnv('STATIC_DIR');
  const staticDir = rawStaticDir === '' ? undefined : rawStaticDir;

  // Self-service signup (#104) is entirely opt-in, gated on RESEND_API_KEY's
  // presence: an empty/unset value leaves `signup` undefined below, so a
  // deployment that hasn't configured any of the three new env vars is
  // completely unaffected (see AppConfig.signup's doc comment in app.ts).
  // Once RESEND_API_KEY is set, EMAIL_FROM_ADDRESS and PUBLIC_APP_URL become
  // required -- failing fast at boot (same style as SESSION_SECRET above)
  // rather than booting into a half-configured signup feature that would
  // only reveal its brokenness on the first real signup attempt.
  const resendApiKey = readEnv('RESEND_API_KEY');
  let signup: NonNullable<Parameters<typeof createApp>[0]['signup']> | undefined;
  if (resendApiKey !== undefined && resendApiKey !== '') {
    const emailFromAddress = readEnv('EMAIL_FROM_ADDRESS');
    if (emailFromAddress === undefined || emailFromAddress === '') {
      throw new Error('EMAIL_FROM_ADDRESS is not set (required when RESEND_API_KEY is set)');
    }
    const publicAppUrl = readEnv('PUBLIC_APP_URL');
    if (publicAppUrl === undefined || publicAppUrl === '') {
      throw new Error('PUBLIC_APP_URL is not set (required when RESEND_API_KEY is set)');
    }
    signup = {
      fromAddress: emailFromAddress,
      publicAppUrl,
      sendEmail: createResendSender(resendApiKey, emailFromAddress),
    };
  }

  const app = createApp({
    dataDir,
    credentials,
    sessionSecret,
    trustProxy,
    insecureCookies,
    ...(staticDir !== undefined ? { staticDir } : {}),
    ...(signup !== undefined ? { signup } : {}),
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
