#!/usr/bin/env node
import { createApp } from './app.js';
import { CredentialsConfigError, loadCredentials } from './credentials.js';
import type { Credential } from './credentials.js';

const DEFAULT_PORT = 8080;
const DEFAULT_DATA_DIR = 'data';

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

/**
 * Validates all required configuration and builds the app, but does not
 * start listening -- callers decide when (and whether) to accept
 * connections. Throws synchronously on any misconfiguration, so the process
 * fails fast at boot rather than on the first request.
 */
export function boot(): ReturnType<typeof createApp> {
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

  return createApp({ dataDir, credentials, sessionSecret });
}

function main(): void {
  let app: ReturnType<typeof createApp>;
  try {
    app = boot();
  } catch (err) {
    console.error(`budget-tracker server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const port = Number(readEnv('PORT') ?? String(DEFAULT_PORT));
  app.listen(port, () => {
    console.log(`budget-tracker server listening on port ${port}`);
  });
}

main();
