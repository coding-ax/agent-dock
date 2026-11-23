import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpxAdapter, listAcpxBuiltinAgents } from './index.js';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))));

async function bin(root: string) {
  const directory = join(root, 'bin');
  await mkdir(directory);
  return directory;
}

async function executable(directory: string, name: string, body = '#!/bin/sh\nexit 0\n') {
  const file = join(directory, process.platform === 'win32' && !name.includes('.') ? `${name}.exe` : name);
  await writeFile(file, body, { mode: 0o755 });
  await chmod(file, 0o755);
  return file;
}

function antigravity(options: { PATH: string }) {
  return listAcpxBuiltinAgents({ env: options, platform: process.platform }).filter(agent => agent.id === 'antigravity');
}

describe('Antigravity ACP launcher', () => {
  it('resolves the installed agy CLI to an absolute path and launches ACP', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-agy-')); dirs.push(root);
    const directory = await bin(root);
    const agy = await executable(directory, 'agy');

    expect(antigravity({ PATH: directory })).toEqual([{ id: 'antigravity', argv: [agy, 'acp'] }]);
  });

  it('accepts the antigravity executable alias without creating a duplicate Agent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-agy-alias-')); dirs.push(root);
    const directory = await bin(root);
    const alias = await executable(directory, 'antigravity');

    expect(antigravity({ PATH: directory })).toEqual([{ id: 'antigravity', argv: [alias, 'acp'] }]);
  });

  it('prefers agy when both names are installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-agy-dedupe-')); dirs.push(root);
    const directory = await bin(root);
    const agy = await executable(directory, 'agy');
    await executable(directory, 'antigravity');

    expect(antigravity({ PATH: directory })).toEqual([{ id: 'antigravity', argv: [agy, 'acp'] }]);
  });

  it('keeps the legacy ACP server as a fallback when no agy CLI is installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentdock-agy-legacy-')); dirs.push(root);
    const directory = await bin(root);
    const legacy = await executable(directory, process.platform === 'win32' ? 'agy_acp_server.exe' : 'agy_acp_server.par');
    const legacyArgs = process.platform === 'linux' ? ['--uid='] : [];

    expect(antigravity({ PATH: directory })).toEqual([{ id: 'antigravity', argv: [legacy, ...legacyArgs] }]);
  });

  it('completes an ACP turn through the resolved agy acp command', async () => {
    if (process.platform === 'win32') return;
    const root = await mkdtemp(join(tmpdir(), 'agentdock-agy-acp-')); dirs.push(root);
    const directory = await bin(root);
    const argsFile = join(root, 'args.json');
    const mock = pathToFileURL(resolve(process.cwd(), 'tests/fixtures/mock-acp-agent.mjs')).href;
    const agy = await executable(directory, 'agy', `#!${process.execPath}
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
await import(${JSON.stringify(mock)});
`);
    const listed = antigravity({ PATH: directory })[0]!;
    const events: any[] = [];
    const adapter = new AcpxAdapter({
      id: 'antigravity',
      name: 'Google Antigravity',
      command: listed.argv[0]!,
      args: listed.argv.slice(1),
      protocol: 'acp',
      cwd: root,
      env: {},
      permissionMode: 'deny-all',
      timeout: 10,
      capabilities: { pause: false, resume: true },
      builtin: true
    }, { sessionKey: `antigravity-${crypto.randomUUID()}`, onEvent: event => events.push(event) });
    try {
      await adapter.start();
      await adapter.send('hello');
      expect(events.some(event => event.type === 'text' && event.data.text.includes('Mock reply'))).toBe(true);
    } finally {
      await adapter.stop({ discardSession: true });
    }
    expect(JSON.parse(await readFile(argsFile, 'utf8'))).toEqual(['acp']);
  });
});
