import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pidAlive,
  readDaemonStatus,
  writeState,
  writePidFile,
  clearState,
  defaultDaemonDir,
  isDaemonRunning,
  daemonPaths
} from './daemon.js';
import { daemonRestartOptions, daemonStart, daemonStop, daemonStatus, readStartupLog } from './command.js';

describe('AgentDock daemon session', () => {
  let tmp: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'agentdock-daemon-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmp);
    vi.stubEnv('HOME', tmp);
  });

  afterEach(() => {
    cwdSpy.mockRestore();
    vi.unstubAllEnvs();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reports false for a non-running or absent daemon', () => {
    expect(isDaemonRunning()).toBe(false);
    expect(daemonStatus().running).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(Number.NaN)).toBe(false);
  });

  it('reads a state written by the daemon child', () => {
    const dir = defaultDaemonDir();
    writeState(dir, { pid: 4242, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, address: 'http://127.0.0.1:4310' });
    writePidFile(dir, 4242);
    const state = readDaemonStatus(dir);
    expect(state).toMatchObject({ pid: 4242, ready: true, address: 'http://127.0.0.1:4310' });
    expect(daemonPaths(dir).logFile).toBe(join(tmp, '.agentdock', 'daemon', 'agentdock.log'));
    expect(readFileSync(join(dir, 'agentdock.pid'), 'utf8').trim()).toBe('4242');
    expect(daemonStatus().running).toBe(false); // 4242 is not an alive process
    clearState(dir);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('daemonStart in the child branch records pid and serves in-band', async () => {
    const serve = vi.fn();
    const env = { HOME: tmp, AGENTDOCK_DAEMONIZED: '1', AGENTDOCK_DAEMON_CWD: tmp, AGENTDOCK_DAEMON_STARTED_AT: '2024-01-01T00:00:00.000Z' } as NodeJS.ProcessEnv;
    const result = await daemonStart({ port: '4310' }, { serve }, env);
    expect(result).toMatchObject({ ok: true, action: 'start', running: true, pid: process.pid });
    expect(serve).toHaveBeenCalledOnce();
    const state = readDaemonStatus(defaultDaemonDir());
    expect(state).toMatchObject({ pid: process.pid, ready: false, address: 'http://127.0.0.1:4310', database: join(tmp, '.agentdock', 'agentdock.db') });
    expect(serve).toHaveBeenCalledWith(expect.objectContaining({ database: join(tmp, '.agentdock', 'agentdock.db') }), expect.any(Function));
  });

  it('persists the web console credential URL handed back by serve and surfaces it in status', async () => {
    const consoleUrl = 'http://127.0.0.1:4310/?t=master-token';
    const serve = vi.fn((_options: unknown, onReady?: (info?: { webConsoleUrl?: string }) => void) => {
      onReady?.({ webConsoleUrl: consoleUrl });
    });
    const env = { HOME: tmp, AGENTDOCK_DAEMONIZED: '1', AGENTDOCK_DAEMON_CWD: tmp, AGENTDOCK_DAEMON_STARTED_AT: '2024-01-01T00:00:00.000Z' } as NodeJS.ProcessEnv;
    const result = await daemonStart({ port: '4310' }, { serve }, env);
    expect(readDaemonStatus(defaultDaemonDir())?.webConsoleUrl).toBe(consoleUrl);
    // restart 的结果 JSON 由 daemonized child 自己打出，返回值必须带凭证链接。
    expect(result).toMatchObject({ ok: true, action: 'start', running: true, webConsoleUrl: consoleUrl });
    // 当前进程就是 state 里的 pid，status 会判定存活并原样返回凭证链接。
    expect(daemonStatus().webConsoleUrl).toBe(consoleUrl);
  });

  it('reuses the first AgentDock root after the daemon has stopped', async () => {
    const firstRoot = join(tmp, 'agent-dock-root');
    const otherCwd = join(tmp, 'somewhere-else');
    mkdirSync(firstRoot, { recursive: true });
    mkdirSync(otherCwd, { recursive: true });
    const canonicalDir = defaultDaemonDir(firstRoot);
    mkdirSync(canonicalDir, { recursive: true });
    const { writeLastDaemonDir, resolveDaemonDir } = await import('./daemon.js');
    writeLastDaemonDir(canonicalDir, tmp);
    expect(resolveDaemonDir(otherCwd, tmp)).toBe(canonicalDir);
  });

  it('ignores a remembered root that no longer exists', async () => {
    const otherCwd = join(tmp, 'current-root');
    mkdirSync(otherCwd, { recursive: true });
    const { writeLastDaemonDir, resolveDaemonDir } = await import('./daemon.js');
    writeLastDaemonDir(join(tmp, 'deleted-root', '.agentdock', 'daemon'), tmp);
    expect(resolveDaemonDir(otherCwd, tmp)).toBe(defaultDaemonDir(otherCwd));
  });

  it('daemonStatus reports an alive daemon using a real child process', async () => {
    // Spawn a short-lived sleep child and use its pid as a fake daemon.
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { stdio: 'ignore' });
    const dir = defaultDaemonDir();
    writeState(dir, { pid: child.pid!, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, address: 'http://127.0.0.1:4310' });
    const status = daemonStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(child.pid);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
  });

  it('daemonStop SIGTERMs an alive daemon and clears state', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], { stdio: 'ignore' });
    const dir = defaultDaemonDir();
    writeState(dir, { pid: child.pid!, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const result = await daemonStop();
    await exited;
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, pid: child.pid });
    expect(isDaemonRunning()).toBe(false);
    expect(readDaemonStatus(dir)).toBeUndefined();
  });

  it('daemonStop reports not-running when nothing is recorded', async () => {
    const result = await daemonStop();
    expect(result).toMatchObject({ ok: true, action: 'stop', running: false, state: 'not-running' });
  });

  it('readStartupLog 只回读 offset 之后的新增日志并 trim', () => {
    const logFile = join(tmp, 'agentdock.log');
    writeFileSync(logFile, 'old line\n');
    const offset = readFileSync(logFile, 'utf8').length;
    writeFileSync(logFile, 'new startup line\n', { flag: 'a' });
    expect(readStartupLog(logFile, offset)).toBe('new startup line');
  });

  it('readStartupLog 缺失文件返回空串，并按 maxBytes 截断', () => {
    expect(readStartupLog(join(tmp, 'missing.log'), 0)).toBe('');
    const logFile = join(tmp, 'big.log');
    writeFileSync(logFile, 'x'.repeat(100));
    const tail = readStartupLog(logFile, 0, 10);
    expect(tail).toBe('x'.repeat(10));
  });

  it('preserves the previous host and port on restart unless explicitly overridden', () => {
    const previous = { pid: 42, ready: true, startedAt: '2024-01-01T00:00:00.000Z', cwd: tmp, database: join(tmp, '.agentdock', 'agentdock.db'), host: '127.0.0.1', port: 4600 };
    expect(daemonRestartOptions({}, previous)).toMatchObject({ cwd: tmp, database: join(tmp, '.agentdock', 'agentdock.db'), host: '127.0.0.1', port: '4600' });
    expect(daemonRestartOptions({ host: '0.0.0.0', port: '4700' }, previous)).toMatchObject({ host: '0.0.0.0', port: '4700' });
    expect(daemonRestartOptions({}, undefined, {
      AGENTDOCK_DAEMON_RESTART_CWD: tmp,
      AGENTDOCK_DAEMON_RESTART_DATABASE: join(tmp, '.agentdock', 'agentdock.db'),
      AGENTDOCK_DAEMON_RESTART_HOST: '127.0.0.1',
      AGENTDOCK_DAEMON_RESTART_PORT: '4600'
    })).toMatchObject({ cwd: tmp, database: join(tmp, '.agentdock', 'agentdock.db'), host: '127.0.0.1', port: '4600' });
  });
});
