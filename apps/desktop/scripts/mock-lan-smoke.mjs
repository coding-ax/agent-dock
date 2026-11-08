#!/usr/bin/env node
/**
 * Desktop LAN-access smoke test.
 *
 * Round 1: settings.json has lanAccess=true — the shell must start the bundled
 * daemon on 0.0.0.0 with the web gate on. Loopback is still auto-authorized
 * (local owner), while the same API over the LAN address must return 401.
 *
 * Round 2: lanAccess=false — the daemon binds loopback only, so a LAN fetch is
 * refused outright and the loopback API stays available.
 *
 * Uses a disposable Electron profile; never touches the installed app or the
 * production daemon. Requires `pnpm build` first.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const desktopDir = resolve(here, '..');
const repoRoot = resolve(desktopDir, '..', '..');

const fail = message => { console.error(`[lan-smoke] ${message}`); process.exit(1); };

function electronBinary() {
  const requireFromDesktop = createRequire(join(desktopDir, 'package.json'));
  const value = String(requireFromDesktop('electron')).trim().split('\n').filter(Boolean).at(-1) ?? '';
  if (!value || !existsSync(value)) fail(`cannot find the Electron binary: ${value || '(empty)'}`);
  return value;
}

function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info && info.family === 'IPv4' && !info.internal) return info.address;
    }
  }
  return undefined;
}

function killTree(pid) {
  try {
    const ps = spawnSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
    const table = (ps.stdout ?? '').trim().split('\n').map(line => line.trim().split(/\s+/)).filter(parts => parts.length === 2).map(([child, parent]) => [Number(child), Number(parent)]);
    const children = new Map();
    for (const [child, parent] of table) children.set(parent, [...(children.get(parent) ?? []), child]);
    const stack = [pid];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (!current || seen.has(current)) continue;
      seen.add(current);
      stack.push(...(children.get(current) ?? []));
    }
    for (const target of [...seen].reverse()) { try { process.kill(target, 'SIGTERM'); } catch { /* gone */ } }
    setTimeout(() => { for (const target of seen) { try { process.kill(target, 'SIGKILL'); } catch { /* gone */ } } }, 1_500).unref?.();
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

async function waitForPort(profile, child, timeoutMs = 60_000) {
  const file = join(profile, 'settings.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return undefined;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (Number.isInteger(saved.port)) return saved.port;
    } catch { /* not written yet */ }
    await sleep(250);
  }
  return undefined;
}

async function probe(url, init) {
  try {
    const response = await fetch(url, init);
    return { status: response.status };
  } catch (error) {
    return { error: error?.cause?.code ?? error?.code ?? String(error) };
  }
}

async function runRound({ label, lanAccess }) {
  const root = mkdtempSync(join(tmpdir(), `agentdock-lan-${label}-`));
  const profile = join(root, 'profile');
  const work = join(root, 'work');
  mkdirSync(profile, { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({ lanAccess }));

  const env = {
    ...process.env,
    AGENTDOCK_DESKTOP_CLI: join(repoRoot, 'apps', 'server', 'dist', 'cli.js'),
    AGENTDOCK_DESKTOP_NODE: process.execPath,
    AGENTDOCK_DESKTOP_USER_DATA: profile,
    AGENTDOCK_DESKTOP_CWD: work
  };
  console.log(`[lan-smoke] round "${label}": lanAccess=${lanAccess}`);
  const child = spawn(electronBinary(), [desktopDir], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += String(chunk); });

  try {
    const port = await waitForPort(profile, child);
    if (!port) fail(`round "${label}" did not report a port\n${stderr.slice(-2_000)}`);
    const lan = lanAddress();
    if (!lan) fail('no LAN IPv4 address on this machine; cannot verify LAN exposure');
    const loopback = await probe(`http://127.0.0.1:${port}/api/system/share-settings`);
    // The gate is on even in loopback-only mode: a cross-site page must not ride
    // the local-owner free pass. This is what makes public QR links signable
    // without exposing the daemon to the LAN first.
    const crossSite = await probe(`http://127.0.0.1:${port}/api/sessions`, { headers: { 'sec-fetch-site': 'cross-site' } });
    const lanApi = await probe(`http://${lan}:${port}/api/sessions`);
    const logFile = join(profile, 'logs', 'daemon.log');
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';

    if (lanAccess) {
      if (!log.includes('--host 0.0.0.0')) fail(`round "${label}": daemon was not started with --host 0.0.0.0\n${log.slice(-2_000)}`);
      if (!log.includes('局域网访问开启')) fail(`round "${label}": startup log does not mention LAN mode`);
      if (loopback.status !== 200) fail(`round "${label}": loopback API expected 200, got ${JSON.stringify(loopback)}`);
      if (crossSite.status !== 401) fail(`round "${label}": cross-site loopback request expected 401, got ${JSON.stringify(crossSite)}`);
      if (lanApi.status !== 401) fail(`round "${label}": LAN API expected 401 with the web gate on, got ${JSON.stringify(lanApi)}`);
    } else {
      if (!log.includes('--local-only')) fail(`round "${label}": daemon was not started with --local-only\n${log.slice(-2_000)}`);
      if (loopback.status !== 200) fail(`round "${label}": loopback API expected 200, got ${JSON.stringify(loopback)}`);
      if (crossSite.status !== 401) fail(`round "${label}": cross-site loopback request expected 401, got ${JSON.stringify(crossSite)}`);
      if (lanApi.status !== undefined) fail(`round "${label}": LAN API expected a refused connection, got HTTP ${lanApi.status}`);
    }
    return { port, loopback, crossSite, lanApi };
  } finally {
    killTree(child.pid);
    await sleep(800);
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  if (!existsSync(join(repoRoot, 'apps', 'server', 'dist', 'cli.js'))) fail('apps/server/dist/cli.js is missing. Run `pnpm build` first.');
  const on = await runRound({ label: 'lan-on', lanAccess: true });
  const off = await runRound({ label: 'lan-off', lanAccess: false });
  console.log('');
  console.log('[lan-smoke] PASS');
  console.log(`  lan-on:  loopback ${on.loopback.status}, cross-site ${on.crossSite.status}, LAN ${on.lanApi.status} (auth required)`);
  console.log(`  lan-off: loopback ${off.loopback.status}, cross-site ${off.crossSite.status}, LAN ${off.lanApi.error ?? off.lanApi.status} (refused)`);
}

main().catch(error => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
