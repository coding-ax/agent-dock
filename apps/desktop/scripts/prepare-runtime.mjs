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
 * Hoisted linking is used on purpose: pnpm's isolated layout links packages
 * with symlinks (junctions with absolute targets on Windows), which break once
 * the runtime is copied into an installer. Hoisted mode materialises a flat
 * node_modules, so the shipped tree is relocatable. `.bin` shims are removed
 * afterwards, leaving a runtime with no symlinks at all.
 */

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, copyFileSync, chmodSync, cpSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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
 * Remove pnpm's `.bin` shims. They only exist for shell use and are symlinks;
 * on Windows electron-builder would recreate them as junctions pointing at the
 * build machine. The daemon spawns node and agent scripts by path, so they are
 * not needed inside the app.
 */
function removeBinDirectories(dir) {
  let removed = 0;
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const path = join(current, entry.name);
      if (entry.name === '.bin') {
        rmSync(path, { recursive: true, force: true });
        removed += 1;
      } else {
        walk(path);
      }
    }
  };
  walk(dir);
  return removed;
}

/**
 * pnpm deploy leaves a few workspace symlinks behind (for example
 * `node_modules/.pnpm/node_modules/@agent-dock/cli` pointing back at the
 * monorepo). They may resolve fine next to the workspace but break once the
 * runtime is copied into the app, and electron-builder's deep code signature
 * aborts on a dangling link. The runtime must be self-contained, so remove
 * every link whose target is missing or outside the deployed directory.
 */
function pruneExternalSymlinks(dir) {
  const root = realpathSync(dir);
  const prefix = root.endsWith('/') ? root : `${root}/`;
  let removed = 0;
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        let target = null;
        try {
          target = realpathSync(path);
        } catch {
          // dangling link: target does not exist
        }
        if (target == null || !(target === root || target.startsWith(prefix))) {
          rmSync(path, { force: true });
          removed += 1;
          console.log(`[desktop-runtime] pruned external symlink ${path} -> ${target ?? '(missing)'}`);
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

  // Keep the deploy target inside the workspace: pnpm resolves a relative
  // target against the selected package's directory (apps/server), and on
  // Windows an absolute temp path (C:) is appended to the repo path (D:)
  // instead of being recognised as absolute. Staging next to the runtime also
  // keeps every symlink on one drive, since pnpm links node_modules back to
  // the workspace store.
  const staging = join(runtimeDir, '.deploy');
  const deployTarget = process.platform === 'win32' ? relative(serverDir, staging) : staging;
  rmSync(staging, { recursive: true, force: true });
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  console.log('[desktop-runtime] pnpm deploy @agent-dock/cli --prod --legacy (hoisted)');
  run(pnpm, [
    '--filter',
    '@agent-dock/cli',
    'deploy',
    '--prod',
    '--legacy',
    // Flat, symlink-free node_modules; survives relocation into the app.
    '--config.node-linker=hoisted',
    // The Lark patch targets 1.71.1 while the range resolves to a newer
    // version. The shipped daemon uses the vendored bundle built from the
    // patched workspace copy, so an unused patch here must not fail the build.
    '--config.allowUnusedPatches=true',
    deployTarget
  ], { cwd: repoRoot, shell: process.platform === 'win32' });
  cpSync(staging, deployedDir, { recursive: true, dereference: false, verbatimSymlinks: true, force: true });
  rmSync(staging, { recursive: true, force: true });
  removeBinDirectories(deployedDir);
  pruneExternalSymlinks(deployedDir);

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
