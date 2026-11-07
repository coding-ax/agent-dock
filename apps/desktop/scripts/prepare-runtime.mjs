#!/usr/bin/env node
/**
 * Assemble the runtime that ships inside the desktop installer.
 *
 *   apps/desktop/runtime/
 *     agentdock/      @agent-dock/cli + its production node_modules (patched deps)
 *     node-runtime/   a standalone Node binary (the app must not depend on the
 *                     user having Node installed)
 *
 * Node binary selection:
 *   --node <path>                          copy this executable (local testing)
 *   AGENTDOCK_DESKTOP_NODE_BIN=<path>      same via env
 *   otherwise                              download AGENTDOCK_NODE_VERSION (default 24.16.0)
 *                                          for the current platform/arch from nodejs.org
 *
 * `pnpm deploy` keeps the patched acpx / Lark SDK that the workspace relies on.
 * Symlinks are preserved: all of them are relative and stay inside the copied
 * tree, which electron-builder copies verbatim into resources/agentdock.
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, copyFileSync, chmodSync, cpSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '..');
const repoRoot = resolve(desktopDir, '..', '..');
const runtimeDir = join(desktopDir, 'runtime');
const serverDir = join(repoRoot, 'apps', 'server');
const deployedDir = join(runtimeDir, 'agentdock');
const nodeDir = join(runtimeDir, 'node-runtime');

const args = process.argv.slice(2);
const nodeArgIndex = args.indexOf('--node');
const nodeOverride = nodeArgIndex >= 0 ? args[nodeArgIndex + 1] : process.env.AGENTDOCK_DESKTOP_NODE_BIN;

function fail(message) {
  console.error(`[desktop-runtime] ${message}`);
  process.exit(1);
}

function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, { stdio: 'inherit', ...options });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with ${result.status}`);
}

/**
 * pnpm deploy leaves a few workspace symlinks behind (for example
 * `node_modules/.pnpm/node_modules/@agent-dock/cli` pointing back at the
 * monorepo). They are harmless for `require`, but electron-builder walks and
 * stats every file while signing, and a dangling symlink aborts the build with
 * ENOENT. Prune only links whose target does not exist; every real package
 * link stays intact.
 */
function pruneBrokenSymlinks(dir) {
  let removed = 0;
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try {
          statSync(path);
        } catch {
          rmSync(path, { force: true });
          removed += 1;
          console.log(`[desktop-runtime] pruned broken symlink ${path}`);
        }
      } else if (entry.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(dir);
  return removed;
}

function copyNodeBinary(source) {
  if (!existsSync(source)) fail(`Node binary not found: ${source}`);
  mkdirSync(nodeDir, { recursive: true });
  const target = join(nodeDir, process.platform === 'win32' ? 'node.exe' : 'node');
  copyFileSync(source, target);
  if (process.platform !== 'win32') chmodSync(target, 0o755);
  console.log(`[desktop-runtime] node <- ${source}`);
}

async function downloadNode(version) {
  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const extension = osName === 'win' ? 'zip' : 'tar.gz';
  const archiveName = `node-v${version}-${osName}-${arch}.${extension}`;
  const url = `https://nodejs.org/dist/v${version}/${archiveName}`;
  const work = join(tmpdir(), `agentdock-node-${process.pid}`);
  const archive = join(work, archiveName);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  console.log(`[desktop-runtime] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) fail(`download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));
  run('tar', ['-xf', archive, '-C', work]);
  const extracted = readdirSync(work).map(name => join(work, name)).find(path => statSync(path).isDirectory());
  if (!extracted) fail('Node archive did not contain a directory');
  const binary = join(extracted, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  copyNodeBinary(existsSync(binary) ? binary : join(extracted, 'node.exe'));
  rmSync(work, { recursive: true, force: true });
}

async function main() {
  if (!existsSync(join(serverDir, 'dist', 'cli.js'))) {
    fail('apps/server/dist/cli.js is missing. Run `pnpm build` first.');
  }
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });

  const staging = join(tmpdir(), `agentdock-deploy-${process.pid}`);
  rmSync(staging, { recursive: true, force: true });
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  console.log('[desktop-runtime] pnpm deploy @agent-dock/cli --prod --legacy');
  run(pnpm, ['--filter', '@agent-dock/cli', 'deploy', '--prod', '--legacy', staging], { cwd: repoRoot, shell: process.platform === 'win32' });
  cpSync(staging, deployedDir, { recursive: true, dereference: false, verbatimSymlinks: true, force: true });
  rmSync(staging, { recursive: true, force: true });
  pruneBrokenSymlinks(deployedDir);

  if (!existsSync(join(deployedDir, 'dist', 'cli.js'))) fail('deployed runtime is missing dist/cli.js');
  if (!existsSync(join(deployedDir, 'public', 'index.html'))) fail('deployed runtime is missing the web UI; run `pnpm build` first');

  if (nodeOverride) {
    copyNodeBinary(resolve(nodeOverride));
  } else {
    const version = process.env.AGENTDOCK_NODE_VERSION || '24.16.0';
    await downloadNode(version);
  }

  const size = (dir) => {
    const result = spawnSync('du', ['-sh', dir], { encoding: 'utf8' });
    return (result.stdout || '').split(/\s+/)[0] || '?';
  };
  console.log(`[desktop-runtime] ready: ${deployedDir} (${size(deployedDir)}), ${nodeDir} (${size(nodeDir)})`);
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
