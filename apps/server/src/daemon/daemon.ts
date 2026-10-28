import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AccessUrl } from '../access-urls.js';

/**
 * Self-managed background daemon for the AgentDock local session server.
 *
 * `agent-dock start` re-spawns itself out of band with a detached
 * `child_process.spawn` and then keeps running to wait for readiness, leaving
 * a background child that owns the server. That child records its PID plus
 * metadata under the working directory's `.agentdock/daemon/` so `stop` /
 * `restart` / `status` can locate and control it without any external
 * supervisor (no pm2 / systemd).
 *
 * Parent vs. daemon child split is signalled through the
 * `AGENTDOCK_DAEMONIZED` environment variable set on the respawned child.
 */

export const DAEMON_ENV_FLAG = 'AGENTDOCK_DAEMONIZED';
export const DAEMON_CWD_ENV = 'AGENTDOCK_DAEMON_CWD';
export const DAEMON_STARTED_AT_ENV = 'AGENTDOCK_DAEMON_STARTED_AT';

export const PID_FILE = 'agentdock.pid';
export const STATE_FILE = 'agentdock.state.json';
export const LOG_FILE = 'agentdock.log';

export interface DaemonState {
  pid: number;
  ready: boolean;
  startedAt: string;
  cwd: string;
  database?: string;
  host?: string;
  port?: number;
  address?: string;
  /**
   * 本机控制台完整访问地址（含 master 凭证 query 参数）。
   * 仅在 web access 门开启时写入；凭证只在启动时打印一次，status/restart
   * 需要靠这个字段让用户随时取回链接，因此 state 文件按 0600 写入。
   */
  webConsoleUrl?: string;
  /**
   * 本机 + 局域网的完整访问入口（含凭证），供 start/restart/status 分条回显。
   * 绑定局域网时只给 127.0.0.1 等于让用户自己猜 IP，IPv6 还得自己补方括号。
   */
  webAccessUrls?: AccessUrl[];
  stoppedAt?: string;
}

export interface DaemonPaths {
  dir: string;
  pidFile: string;
  stateFile: string;
  logFile: string;
}

/** Default daemon directory relative to the working directory. */
export function defaultDaemonDir(cwd = process.cwd()): string {
  return join(cwd, '.agentdock', 'daemon');
}

/** Path to the global pointer file that records the last-started daemon directory. */
export function lastDaemonDirPointerFile(home = process.env.HOME ?? homedir()): string {
  return join(home, '.agentdock', 'last-daemon-dir');
}

/** Read the last-started daemon directory from the global pointer, if any. */
export function readLastDaemonDir(home = process.env.HOME ?? homedir()): string | undefined {
  try {
    const raw = readFileSync(lastDaemonDirPointerFile(home), 'utf8').trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/** Persist the last-started daemon directory to the global pointer. */
export function writeLastDaemonDir(dir: string, home = process.env.HOME ?? homedir()): void {
  const pointerFile = lastDaemonDirPointerFile(home);
  mkdirSync(dirname(pointerFile), { recursive: true });
  writeFileSync(pointerFile, `${dir}\n`, 'utf8');
}

/**
 * Resolve which daemon directory to operate on.
 *
 * Priority:
 * 1. The daemon directory under the current working directory, IF it points at
 *    a live daemon process (stale pid files are ignored).
 * 2. The directory recorded in `~/.agentdock/last-daemon-dir`. It remains the
 *    canonical AgentDock root even while the daemon is stopped, preventing a
 *    later start from silently creating a second database under another cwd.
 * 3. The current working directory's daemon directory on the very first run.
 */
export function resolveDaemonDir(cwd = process.cwd(), home = process.env.HOME ?? homedir()): string {
  const localDir = defaultDaemonDir(cwd);
  if (isDaemonRunning(localDir)) return localDir;
  const lastDir = readLastDaemonDir(home);
  if (lastDir && existsSync(lastDir)) return lastDir;
  return localDir;
}

export function daemonPaths(dir = defaultDaemonDir()): DaemonPaths {
  return { dir, pidFile: join(dir, PID_FILE), stateFile: join(dir, STATE_FILE), logFile: join(dir, LOG_FILE) };
}

/** Returns true when a process with `pid` exists (signal 0 succeeds). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH means the pid does not exist.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readDaemonStatus(dir = defaultDaemonDir()): DaemonState | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(dir, STATE_FILE), 'utf8');
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw) as DaemonState;
  } catch {
    return undefined;
  }
}

export function pidFromState(state?: DaemonState): number {
  return state && Number.isInteger(state.pid) && state.pid > 0 ? state.pid : 0;
}

/**
 * True when a daemon recorded for `dir` is currently alive. A stale PID file
 * (its process no longer exists) counts as not running.
 */
export function isDaemonRunning(dir = defaultDaemonDir()): boolean {
  const pid = pidFromState(readDaemonStatus(dir));
  return pid > 0 && pidAlive(pid);
}

/** The PID read straight from the pid file (0 when absent/unreadable). */
export function readPidFile(dir = defaultDaemonDir()): number {
  try {
    return parseInt(readFileSync(join(dir, PID_FILE), 'utf8').trim(), 10) || 0;
  } catch {
    return 0;
  }
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeState(dir: string, state: DaemonState): void {
  ensureDir(dir);
  const stateFile = join(dir, STATE_FILE);
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  // state 里可能带有含 master 凭证的控制台 URL，收紧为仅当前用户可读写。
  try { chmodSync(stateFile, 0o600); } catch { /* 非 POSIX 或文件系统不支持时忽略 */ }
}

export function writePidFile(dir: string, pid: number): void {
  ensureDir(dir);
  writeFileSync(join(dir, PID_FILE), `${pid}\n`, 'utf8');
}

export function clearState(dir: string): void {
  ensureDir(dir);
  writeFileSync(join(dir, STATE_FILE), '', 'utf8');
  writeFileSync(join(dir, PID_FILE), '', 'utf8');
}

/** Resolved daemon cwd: the recorded cwd, falling back to the supplied one. */
export function daemonCwd(dir: string, fallback = process.cwd()): string {
  return readDaemonStatus(dir)?.cwd || fallback;
}

/** Whether this process is the daemonized child spawned by `agent-dock start`. */
export function isDaemonChild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[DAEMON_ENV_FLAG] === '1';
}

/** Metadata captured by the parent `start` command and passed via env. */
export interface DaemonChildMeta {
  cwd: string;
  startedAt: string;
}

export function childMeta(env: NodeJS.ProcessEnv = process.env): DaemonChildMeta {
  return {
    cwd: env[DAEMON_CWD_ENV] ?? process.cwd(),
    startedAt: env[DAEMON_STARTED_AT_ENV] ?? new Date().toISOString()
  };
}

export interface DaemonizeOptions {
  cwd?: string;
  startedAt?: string;
  env?: NodeJS.ProcessEnv;
}

export interface DaemonizeResult {
  child: ChildProcess;
  logFile: string;
  /** 启动前日志文件大小（字节），用于只回读本次启动新增的日志。 */
  startOffset: number;
}

/**
 * Re-spawn the current `agent-dock` process in the background with stdout /
 * stderr redirected into the daemon log file. Unlike daemonize-process this
 * does NOT exit the caller: the parent polls readiness and prints the startup
 * log, so `agent-dock start/restart` doesn't return in silence.
 */
export function daemonize(options: DaemonizeOptions = {}): DaemonizeResult {
  const cwd = options.cwd ?? process.cwd();
  const logFile = daemonPaths(cwd ? join(cwd, '.agentdock', 'daemon') : defaultDaemonDir()).logFile;
  const startOffset = fileSizeOrZero(logFile);
  const fd = openLogFd(logFile);

  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('Cannot daemonize: process.argv[1] is missing.');
  const child: ChildProcess = spawn(process.execPath, [entrypoint, ...process.argv.slice(2)], {
    cwd,
    stdio: ['ignore', fd, fd],
    detached: true,
    env: {
      ...(options.env ?? process.env),
      [DAEMON_ENV_FLAG]: '1',
      [DAEMON_CWD_ENV]: cwd,
      [DAEMON_STARTED_AT_ENV]: options.startedAt ?? new Date().toISOString()
    }
  });
  child.unref();
  return { child, logFile, startOffset };
}

function fileSizeOrZero(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
}

/** Open a log file for append (creating parent directories), returning its numeric fd. */
function openLogFd(file: string): number {
  mkdirSync(dirname(file), { recursive: true });
  return openSync(file, 'a');
}
