import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Repo root is two levels up from this file (tests/server/*.test.ts).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const webIndexHtmlPath = join(repoRoot, 'web', 'index.html');

// Regression (#96): nothing previously guarded the wiring between
// web/index.html's <script src="/theme-init.js"> tag and the actual file at
// web/public/theme-init.js. Vite serves/copies web/public/* verbatim to the
// site root by filename (dev server and build alike), so this reference is
// pure string matching with no compiler/bundler check behind it -- a rename
// on either side (the script tag's src, or the file under web/public/)
// would silently 404 in the browser and break the anti-FOUC theme bootstrap
// (see web/public/theme-init.js's own doc comment for why this must stay an
// external, same-origin script rather than an inline one: the app's CSP
// enforces script-src 'self' with no 'unsafe-inline').
describe('anti-FOUC theme-init.js script reference (web/index.html <-> web/public/)', () => {
  it('web/index.html references an external script that actually exists under web/public/', () => {
    const indexHtml = readFileSync(webIndexHtmlPath, 'utf-8');

    // Matches a same-origin, non-module external script tag, e.g.
    // <script src="/theme-init.js"></script> -- deliberately excludes the
    // type="module" entry script (main.tsx), which is bundled by Vite, not
    // served verbatim from web/public/.
    const scriptTagMatch = indexHtml.match(
      /<script\s+src="\/([a-zA-Z0-9._-]+\.js)"\s*><\/script>/,
    );
    expect(
      scriptTagMatch,
      'expected web/index.html to contain an external <script src="/....js"></script> tag for the anti-FOUC theme bootstrap',
    ).not.toBeNull();

    const referencedFile = scriptTagMatch![1];
    expect(referencedFile).toBe('theme-init.js');

    const publicFilePath = join(repoRoot, 'web', 'public', referencedFile as string);
    expect(
      existsSync(publicFilePath),
      `web/index.html references "/${referencedFile}" but no such file exists at web/public/${referencedFile}`,
    ).toBe(true);
  });
});
