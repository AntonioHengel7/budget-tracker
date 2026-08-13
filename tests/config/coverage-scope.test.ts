import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../..');

/**
 * coverage-gate.sh's live-run path does NOT filter by .jome/coverage.json's
 * `core` globs — it reads vitest's whole-report total. vite.config.ts's own
 * coverage.include is what actually scopes the number, so the two must be
 * kept identical or the 95% bar silently stops meaning "core coverage".
 */
describe('coverage scope', () => {
  it('.jome/coverage.json core globs match vite.config.ts coverage.include', () => {
    const coverageJson = JSON.parse(
      readFileSync(join(REPO_ROOT, '.jome/coverage.json'), 'utf-8'),
    );
    const viteConfigSource = readFileSync(join(REPO_ROOT, 'vite.config.ts'), 'utf-8');

    // vite.config.ts has two `include:` keys (test.include and test.coverage.include) —
    // scope the search to the `coverage: { ... }` block specifically, not the first match.
    const coverageBlockMatch = /coverage:\s*\{([\s\S]*?)\n\s*\},/.exec(viteConfigSource);
    const coverageBlock = coverageBlockMatch?.[1];
    if (coverageBlock === undefined) {
      throw new Error('vite.config.ts: could not locate a `coverage: { ... }` block');
    }

    const includeMatch = /include:\s*\[([^\]]*)\]/.exec(coverageBlock);
    const includeList = includeMatch?.[1];
    if (includeList === undefined) {
      throw new Error('vite.config.ts: coverage block has no `include: [...]` array');
    }

    const viteInclude = includeList
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);

    expect(coverageJson.core).toEqual(viteInclude);
  });
});
