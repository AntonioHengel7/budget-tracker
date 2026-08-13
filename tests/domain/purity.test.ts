import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DOMAIN_DIR = join(import.meta.dirname, '../../src/domain');

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+['"].*\/storage\//,
  /from\s+['"].*\/cli\//,
  /from\s+['"]node:/,
];

function listDomainFiles(): string[] {
  return readdirSync(DOMAIN_DIR)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(DOMAIN_DIR, name));
}

describe('domain purity', () => {
  it('no file under src/domain imports src/storage, src/cli, or a node: builtin', () => {
    const files = listDomainFiles();
    expect(files.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      for (const pattern of FORBIDDEN_IMPORT_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${file} matches forbidden pattern ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
