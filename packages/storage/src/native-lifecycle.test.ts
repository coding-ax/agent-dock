import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('keeps the process alive when SQLite statements are collected in a foreign V8 context', () => {
  const require = createRequire(import.meta.url);
  const fixture = fileURLToPath(new URL('../../../tests/fixtures/sqlite-gc.cjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', fixture, require.resolve('better-sqlite3')], {
    encoding: 'utf8',
    timeout: 10_000
  });
  expect(result.error).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('sqlite-gc-ok');
});
