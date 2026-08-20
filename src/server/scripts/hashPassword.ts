import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import { BCRYPT_COST } from '../credentials.js';

/**
 * Hashes a plaintext password at the pinned `BCRYPT_COST`, so every hash
 * this script emits is guaranteed to be one `loadCredentials` accepts.
 * Exported (rather than inlined in `main`) so tests can assert on it
 * directly without spawning the CLI as a subprocess.
 */
export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

async function main(): Promise<void> {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: hash-password <password>');
    process.exitCode = 1;
    return;
  }

  const hash = await hashPassword(password);
  console.log(hash);
}

// Only run `main()` when this module is the actual entrypoint (`node
// dist/server/scripts/hashPassword.js`), not when it's imported (e.g. by
// tests importing `hashPassword` for direct testing) -- mirrors the same
// guard in `src/server/index.ts`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
