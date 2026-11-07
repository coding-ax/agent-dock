import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readCodexThreadName } from './codex-thread-name.js';

describe('readCodexThreadName', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  writeFileSync(join(home, 'session_index.jsonl'), [
    JSON.stringify({ id: 'a', thread_name: '旧名字', updated_at: '1' }),
    'not json a',
    JSON.stringify({ id: 'b', thread_name: '另一个会话', updated_at: '2' }),
    JSON.stringify({ id: 'a', thread_name: '新名字', updated_at: '3' }),
    JSON.stringify({ id: 'c', thread_name: '  ', updated_at: '4' })
  ].join('\n'));

  it('takes the last rename for the thread id', async () => { expect(await readCodexThreadName('a', home)).toBe('新名字'); });
  it('returns undefined for unknown ids, blank names, missing ids and missing files', async () => {
    expect(await readCodexThreadName('zzz', home)).toBeUndefined();
    expect(await readCodexThreadName('c', home)).toBeUndefined();
    expect(await readCodexThreadName(undefined, home)).toBeUndefined();
    expect(await readCodexThreadName('a', join(home, 'missing'))).toBeUndefined();
  });
});
