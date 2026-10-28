import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { describeUpdateFailure, SelfUpdateService } from './self-update.js';
import { compareVersions, distTagForVersion } from './update.js';

const daemonEnv = (dir: string) => ({ HOME: dir, AGENTDOCK_DAEMONIZED: '1', AGENTDOCK_DAEMON_CWD: dir, AGENTDOCK_DAEMON_STARTED_AT: 'now' });

describe('version comparison', () => {
  it('orders by semver including prerelease segments', () => {
    expect(compareVersions('0.4.61-beta.20261015.1', '0.4.60-beta.20261014.1')).toBeGreaterThan(0);
    // 本地 pack 的版本比 registry 高时不能判成「有新版本」。
    expect(compareVersions('0.4.30-beta.20261001.1', '0.4.60-beta.20261014.1')).toBeLessThan(0);
    expect(compareVersions('0.4.23', '0.4.23-beta.20261014.1')).toBeGreaterThan(0);
    expect(compareVersions('0.4.23-beta.20261014.2', '0.4.23-beta.20261014.10')).toBeLessThan(0);
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('infers the dist-tag from the running version', () => {
    expect(distTagForVersion('0.4.60-beta.20261014.1')).toBe('beta');
    expect(distTagForVersion('0.1.22-fix.3')).toBe('fix');
    expect(distTagForVersion('0.4.23')).toBe('latest');
  });
});

describe('SelfUpdateService', () => {
  it('caches the registry check and only reports newer versions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-update-'));
    const runNpm = vi.fn(async () => '"0.4.61-beta.20261015.1"');
    let clock = 0;
    const service = new SelfUpdateService({ currentVersion: '0.4.60-beta.20261014.1', packageName: '@agent-dock/cli', cliEntrypoint: '/x/cli.js', env: daemonEnv(dir), runNpm, now: () => clock });
    expect(await service.status()).toMatchObject({ distTag: 'beta', latestVersion: '0.4.61-beta.20261015.1', updateAvailable: true, canUpdate: true, updating: false });
    clock = 10 * 60_000;
    await service.status();
    expect(runNpm).toHaveBeenCalledTimes(1);
    expect(runNpm).toHaveBeenCalledWith(['view', '@agent-dock/cli@beta', 'version', '--json']);
    clock = 31 * 60_000;
    await service.status();
    expect(runNpm).toHaveBeenCalledTimes(2);

    const ahead = new SelfUpdateService({ currentVersion: '0.4.62-beta.20261016.1', packageName: 'p', cliEntrypoint: '/x', env: daemonEnv(dir), runNpm });
    expect((await ahead.status()).updateAvailable).toBe(false);
  });

  it('reports check failures without throwing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-update-'));
    const service = new SelfUpdateService({ currentVersion: '0.4.23', packageName: 'p', cliEntrypoint: '/x', env: daemonEnv(dir), runNpm: async () => { throw new Error('ENOTFOUND registry.npmjs.org\nmore'); } });
    expect(await service.status()).toMatchObject({ updateAvailable: false, checkError: '检查新版本失败：ENOTFOUND registry.npmjs.org' });
  });

  it('spawns a detached `agent-dock update` without daemon markers and blocks a second trigger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-update-'));
    const lockFile = join(dir, 'update.lock');
    let exit: ((code: number | null) => void) | undefined;
    const spawnUpdate = vi.fn((_args: string[], _options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }) => ({ pid: process.pid, onExit: (listener: (code: number | null) => void) => { exit = listener; } }));
    const service = new SelfUpdateService({ currentVersion: '0.4.60-beta.20261014.1', packageName: '@agent-dock/cli', cliEntrypoint: '/g/cli.js', env: daemonEnv(dir), lockFile, runNpm: async () => '"0.4.61-beta.20261015.1"', spawnUpdate });

    expect(await service.start()).toMatchObject({ updating: true });
    const [args, options] = spawnUpdate.mock.calls[0]!;
    expect(args).toEqual(['/g/cli.js', 'update', '--dist-tag', 'beta']);
    expect(options.cwd).toBe(dir);
    expect(options.env.AGENTDOCK_DAEMONIZED).toBeUndefined();
    expect(options.env.AGENTDOCK_DAEMON_CWD).toBeUndefined();
    expect(readFileSync(lockFile, 'utf8')).toBe(String(process.pid));
    await expect(service.start()).rejects.toMatchObject({ code: 'UPDATE_IN_PROGRESS' });

    // 成功时当前进程会被重启杀掉；还能收到退出码说明失败了，要把原因留给界面。
    mkdirSync(dirname(options.logFile), { recursive: true });
    writeFileSync(options.logFile, 'npm error code EACCES\nnpm error path /usr/local/lib/node_modules\n');
    exit!(1);
    expect(existsSync(lockFile)).toBe(false);
    const status = await service.status();
    expect(status.updating).toBe(false);
    expect(status.lastError).toContain('npm install -g @agent-dock/cli@beta && agent-dock restart');
    expect(status.lastError).toContain('写权限');
  });

  it('refuses to update in foreground mode or when already up to date', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-update-'));
    const spawnUpdate = vi.fn();
    const foreground = new SelfUpdateService({ currentVersion: '0.4.23', packageName: 'p', cliEntrypoint: '/x', env: { HOME: dir }, runNpm: async () => '"0.4.24"', spawnUpdate });
    expect((await foreground.status()).canUpdate).toBe(false);
    await expect(foreground.start()).rejects.toMatchObject({ code: 'UPDATE_REQUIRES_DAEMON' });
    const current = new SelfUpdateService({ currentVersion: '0.4.24', packageName: 'p', cliEntrypoint: '/x', env: daemonEnv(dir), runNpm: async () => '"0.4.24"', spawnUpdate });
    await expect(current.start()).rejects.toMatchObject({ code: 'UPDATE_NOT_AVAILABLE' });
    expect(spawnUpdate).not.toHaveBeenCalled();
  });

  it('takes over a stale lock left by a dead process', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ad-update-'));
    const lockFile = join(dir, 'update.lock');
    writeFileSync(lockFile, '99999999');
    const service = new SelfUpdateService({ currentVersion: '0.4.23', packageName: 'p', cliEntrypoint: '/x', env: daemonEnv(dir), lockFile, runNpm: async () => '"0.4.24"', spawnUpdate: () => ({ pid: process.pid, onExit: () => {} }) });
    expect((await service.start()).updating).toBe(true);
    expect(readFileSync(lockFile, 'utf8')).toBe(String(process.pid));
  });

  it('stops reporting an update in progress once the lock is older than any real update', async () => {
    // 升级成功时旧 daemon 被杀，锁留下来；里面的 pid 之后被别的进程复用，不能因此一直显示「正在升级」。
    const dir = mkdtempSync(join(tmpdir(), 'ad-update-'));
    const lockFile = join(dir, 'update.lock');
    writeFileSync(lockFile, String(process.pid));
    let clock = Date.now();
    const service = new SelfUpdateService({ currentVersion: '0.4.23', packageName: 'p', cliEntrypoint: '/x', env: daemonEnv(dir), lockFile, runNpm: async () => '"0.4.23"', now: () => clock });
    expect((await service.status()).updating).toBe(true);
    clock += 16 * 60_000;
    expect((await service.status()).updating).toBe(false);
  });

  it('turns a generic npm failure into a manual command hint', () => {
    expect(describeUpdateFailure('npm error 404 Not Found', 'p', 'beta')).toBe('升级失败：npm error 404 Not Found。可在终端手动执行：npm install -g p@beta && agent-dock restart');
  });
});
