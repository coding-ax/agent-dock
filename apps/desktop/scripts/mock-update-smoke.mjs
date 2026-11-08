#!/usr/bin/env node
/**
 * Local end-to-end smoke test for the desktop updater.
 *
 * It serves a mock electron-updater feed (generic provider) from 127.0.0.1,
 * launches the real Electron shell against a disposable profile, and captures
 * two screenshots:
 *
 *   1. update detected  → the sidebar shows "新版本 x 可用"
 *   2. download running → the sidebar shows the percentage and progress bar
 *
 * The fake download is a large blob with the correct sha512 in the yml. It is
 * never unpacked or installed (the test stops at progress), so it does not need
 * to be a valid app archive.
 *
 * Requires `pnpm build` first: the dev shell starts apps/server/dist/cli.js.
 *
 *   pnpm --filter @agent-dock/desktop smoke:update
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '..');
const repoRoot = resolve(desktopDir, '..', '..');
const outputDir = join(desktopDir, '.smoke');
const feedFile = process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
const zipName = `AgentDock-0.2.0-${process.platform === 'darwin' ? (process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64') : 'win-x64'}.zip`;
const FEED_VERSION = '0.2.0';

const fail = message => {
  console.error(`[smoke] ${message}`);
  process.exit(1);
};

function electronBinary() {
  // The electron package re-exports the platform binary path from its main.
  // Resolve it from apps/desktop so pnpm's workspace link is honoured; the
  // first install may print download progress, so keep the last line.
  const requireFromDesktop = createRequire(join(desktopDir, 'package.json'));
  const value = String(requireFromDesktop('electron')).trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (!value || !existsSync(value)) fail(`cannot find the Electron binary: ${value || '(empty)'}`);
  return value;
}

function findChildren(pid, table) {
  const children = [];
  for (const [child, parent] of table) if (parent === pid) children.push(child);
  return children;
}

function killTree(pid) {
  try {
    const ps = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    const table = (ps.stdout ?? '').trim().split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2).map(([child, parent]) => [Number(child), Number(parent)]);
    const stack = [pid];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      stack.push(...findChildren(current, table));
    }
    // Children first: the detached server must not outlive the shell.
    for (const target of [...seen].reverse()) {
      try { process.kill(target, 'SIGTERM'); } catch { /* already gone */ }
    }
    setTimeout(() => {
      for (const target of seen) {
        try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ }
      }
    }, 1_500).unref?.();
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function writeBlob(path, size) {
  const chunk = Buffer.alloc(1024 * 1024, 0x41);
  const parts = [];
  for (let written = 0; written < size; written += chunk.length) parts.push(chunk);
  const blob = Buffer.concat(parts).subarray(0, size);
  writeFileSync(path, blob);
  return blob;
}

function sha512(buffer) {
  return createHash('sha512').update(buffer).digest('base64');
}

async function runRound({ label, delayMs, autoDownload, blobSize }) {
  const root = mkdtempSync(join(tmpdir(), `agentdock-smoke-${label}-`));
  const feedDir = join(root, 'feed');
  const profile = join(root, 'profile');
  const work = join(root, 'work');
  const screenshot = join(outputDir, `${label}.png`);
  mkdirSync(feedDir, { recursive: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const blobPath = join(feedDir, zipName);
  const blob = writeBlob(blobPath, blobSize);
  const digest = sha512(blob);
  const yaml = [
    `version: ${FEED_VERSION}`,
    'files:',
    `  - url: ${zipName}`,
    `    sha512: "${digest}"`,
    `    size: ${blob.length}`,
    `path: ${zipName}`,
    `sha512: "${digest}"`,
    `releaseDate: '2026-11-08T00:00:00.000Z'`,
    ''
  ].join('\n');

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (pathname === `/${feedFile}`) {
      response.writeHead(200, { 'content-type': 'text/yaml', 'content-length': Buffer.byteLength(yaml) });
      response.end(request.method === 'HEAD' ? undefined : yaml);
      return;
    }
    if (pathname === `/${zipName}`) {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': blob.length });
      if (request.method === 'HEAD') { response.end(); return; }
      let offset = 0;
      const chunkSize = 256 * 1024;
      const pump = () => {
        if (offset >= blob.length) { response.end(); return; }
        const end = Math.min(blob.length, offset + chunkSize);
        response.write(blob.subarray(offset, end));
        offset = end;
        // ~2.5 MB/s keeps the progress visible long enough for the capture.
        setTimeout(pump, 100);
      };
      pump();
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;

  // electron-updater in dev reads this file when forceDevUpdateConfig is on.
  const devConfig = join(desktopDir, 'dev-app-update.yml');
  writeFileSync(devConfig, [
    'provider: generic',
    `url: http://127.0.0.1:${port}`,
    'updaterCacheDirName: agentdock-desktop-smoke',
    ''
  ].join('\n'));

  const env = {
    ...process.env,
    AGENTDOCK_DESKTOP_CLI: join(repoRoot, 'apps', 'server', 'dist', 'cli.js'),
    AGENTDOCK_DESKTOP_NODE: process.execPath,
    AGENTDOCK_DESKTOP_USER_DATA: profile,
    AGENTDOCK_DESKTOP_CWD: work,
    AGENTDOCK_DESKTOP_UPDATE_URL: `http://127.0.0.1:${port}`,
    AGENTDOCK_DESKTOP_UPDATE_CHECK_DELAY_MS: '1500',
    AGENTDOCK_DESKTOP_UPDATE_DEBUG: '1',
    AGENTDOCK_DESKTOP_CAPTURE: screenshot,
    AGENTDOCK_DESKTOP_CAPTURE_DELAY_MS: String(delayMs),
    AGENTDOCK_DESKTOP_CAPTURE_OPEN_SETTINGS: '1',
    ...(autoDownload ? { AGENTDOCK_DESKTOP_UPDATE_AUTO_DOWNLOAD: '1' } : {})
  };

  console.log(`[smoke] round "${label}": feed=http://127.0.0.1:${port}/${feedFile} capture=${screenshot}`);
  const child = spawn(electronBinary(), [desktopDir], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', chunk => { stdout += String(chunk); });
  child.stderr?.on('data', chunk => { stderr += String(chunk); });

  const result = await new Promise(resolveExit => {
    const timer = setTimeout(() => {
      killTree(child.pid);
      resolveExit({ code: 'timeout', signal: null });
    }, 90_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });

  server.close();
  rmSync(devConfig, { force: true });

  const logFile = join(profile, 'logs', 'daemon.log');
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  const logTail = log.split('\n').slice(-40).join('\n');
  if (result.code === 'timeout') fail(`round "${label}" timed out\n${logTail}\n${stderr.slice(-2_000)}`);
  if (!existsSync(screenshot)) fail(`round "${label}" produced no screenshot\n${logTail}\n${stderr.slice(-2_000)}`);

  return { label, screenshot, log, root, stdout, stderr, code: result.code };
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function main() {
  if (!existsSync(join(repoRoot, 'apps', 'server', 'dist', 'cli.js'))) {
    fail('apps/server/dist/cli.js is missing. Run `pnpm build` first.');
  }
  if (!existsSync(join(repoRoot, 'apps', 'server', 'public', 'index.html'))) {
    fail('apps/server/public is missing. Run `pnpm build` first.');
  }

  const detected = await runRound({ label: 'round1-available', delayMs: 5_000, autoDownload: false, blobSize: 8 * 1024 * 1024 });
  assert(/\[update\] available/.test(detected.log), 'round1: updater never reached "available"');
  assert(!/\[update\] downloading/.test(detected.log), 'round1: downloaded without user confirmation');

  const progress = await runRound({ label: 'round2-progress', delayMs: 7_000, autoDownload: true, blobSize: 24 * 1024 * 1024 });
  const percents = [...progress.log.matchAll(/\[update\] downloading[^\n]*?(\d+)%/g)].map(match => Number(match[1]));
  assert(percents.length > 0, 'round2: no download progress was reported');
  const maxPercent = Math.max(...percents);
  assert(maxPercent > 0 && maxPercent < 100, `round2: expected an in-flight progress capture, saw ${maxPercent}%`);

  console.log('');
  console.log('[smoke] PASS');
  console.log(`  round1: ${detected.screenshot} (available; ${detected.log.match(/\[update\] available[^\n]*/)?.[0] ?? 'state logged'})`);
  console.log(`  round2: ${progress.screenshot} (downloading; max ${maxPercent}% of ${percents.length} progress events)`);
  console.log(`  logs: ${detected.root}  ${progress.root}`);
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
