import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { commandExists, probeAgent } from './index.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

it('recognizes the running Node executable and allows ACP sessions', () => {
  expect(commandExists(process.execPath)).toBe(true);
  expect(probeAgent({ id: 'test', name: 'Test', command: process.execPath, args: [], protocol: 'acp', env: {}, permissionMode: 'ask', timeout: 10, capabilities: { pause: false, resume: true }, builtin: false }).available).toBe(true);
});

it('rejects missing paths and directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdock-command-'));
  dirs.push(dir);
  expect(commandExists(join(dir, 'missing.exe'))).toBe(false);
  expect(commandExists(dir)).toBe(false);
});

it.skipIf(process.platform === 'win32')('rejects files without executable permission on POSIX', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentdock-command-'));
  dirs.push(dir);
  const file = join(dir, 'not-executable');
  await writeFile(file, 'echo hello', { mode: 0o600 });
  expect(commandExists(file)).toBe(false);
});
