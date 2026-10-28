import { readFileSync } from 'node:fs';
import {
  childMeta,
  clearState,
  daemonPaths,
  daemonize,
  defaultDaemonDir,
  isDaemonChild,
  pidAlive,
  pidFromState,
  readDaemonStatus,
  resolveDaemonDir,
  writeLastDaemonDir,
  writePidFile,
  writeState,
  type DaemonState
} from './daemon.js';
import type { CliOptions } from '../cli-program.js';
import type { AccessUrl } from '../access-urls.js';
import { sleep } from './time.js';
import { resolve } from 'node:path';

/** 回读启动日志时最多展示的字节数，避免把陈年日志全喷出来。 */
const STARTUP_LOG_MAX_BYTES = 16 * 1024;

export interface DaemonCommandResult {
  ok: boolean;
  action: 'start' | 'stop' | 'restart' | 'status';
  running: boolean;
  pid?: number;
  address?: string;
  logFile?: string;
  state?: 'started' | 'already-running' | 'not-running' | 'stopped' | 'restarted';
  /** 含访问凭证的本机控制台地址，仅在 web access 门开启时存在。 */
  webConsoleUrl?: string;
  /** 分条回显的访问入口（本机 + 局域网 v4/v6），含凭证。 */
  webAccessUrls?: AccessUrl[];
  /** 本次启动新增的 daemon 日志（监听地址、报错堆栈等），供 start/restart 直接回显。 */
  startupLog?: string;
  error?: string;
}

const READY_TIMEOUT_MS = 15_000;
const RESTART_HOST_ENV = 'AGENTDOCK_DAEMON_RESTART_HOST';
const RESTART_PORT_ENV = 'AGENTDOCK_DAEMON_RESTART_PORT';
const RESTART_CWD_ENV = 'AGENTDOCK_DAEMON_RESTART_CWD';
const RESTART_DATABASE_ENV = 'AGENTDOCK_DAEMON_RESTART_DATABASE';

export interface DaemonReadyInfo {
  /** 含 master 凭证的完整控制台地址，由 serve 在服务启动后回传。 */
  webConsoleUrl?: string;
  /** 本机与局域网的全部入口，由 serve 在服务启动后回传。 */
  webAccessUrls?: AccessUrl[];
}

export interface DaemonCommandHandlers {
  serve(options: CliOptions, onReady?: (info?: DaemonReadyInfo) => void): Promise<void> | void;
}

export function daemonRestartOptions(options: CliOptions, previousState?: DaemonState, env: NodeJS.ProcessEnv = {}): CliOptions {
  return {
    ...options,
    ...(options.cwd === undefined && (previousState?.cwd ?? env[RESTART_CWD_ENV]) ? { cwd: previousState?.cwd ?? env[RESTART_CWD_ENV] } : {}),
    ...(options.database === undefined && (previousState?.database ?? env[RESTART_DATABASE_ENV]) ? { database: previousState?.database ?? env[RESTART_DATABASE_ENV] } : {}),
    ...(options.host === undefined && (previousState?.host ?? env[RESTART_HOST_ENV]) ? { host: previousState?.host ?? env[RESTART_HOST_ENV] } : {}),
    ...(options.port === undefined && (previousState?.port ?? env[RESTART_PORT_ENV]) ? { port: String(previousState?.port ?? env[RESTART_PORT_ENV]) } : {})
  };
}

/** Mark the running daemon as ready and refresh its live metadata. */
export function markDaemonReady(dir: string, patch: Partial<Pick<DaemonState, 'host' | 'port' | 'address' | 'database' | 'webConsoleUrl' | 'webAccessUrls'>> = {}): void {
  const previous = readDaemonStatus(dir);
  writeState(dir, {
    pid: process.pid,
    ready: true,
    startedAt: previous?.startedAt ?? new Date().toISOString(),
    cwd: process.cwd(),
    ...patch
  });
}

/**
 * Entry point for `agent-dock start`. From the foreground it re-spawns the
 * server as a detached daemon then exits; inside the detached child (signalled
 * via `AGENTDOCK_DAEMONIZED`) it records self metadata and serves in-band.
 */
export async function daemonStart(options: CliOptions, handlers: DaemonCommandHandlers, env: NodeJS.ProcessEnv = process.env): Promise<DaemonCommandResult> {
  const invocationCwd = process.cwd();
  const dir = isDaemonChild(env) ? defaultDaemonDir(invocationCwd) : resolveDaemonDir(invocationCwd, env.HOME);
  const cwd = isDaemonChild(env) ? invocationCwd : resolve(dir, '../..');
  const database = resolve(cwd, options.database ?? '.agentdock/agentdock.db');

  if (isDaemonChild(env)) {
    // We are the detached child: own the server and publish self metadata.
    const meta = childMeta(env);
    writePidFile(dir, process.pid);
    writeState(dir, {
      pid: process.pid,
      ready: false,
      startedAt: meta.startedAt,
      cwd,
      database,
      ...addressFromCli(options)
    });
    writeLastDaemonDir(dir, env.HOME);
    await handlers.serve({ ...options, database }, info => markDaemonReady(dir, {
      ...addressFromCli(options),
      database,
      ...(info?.webConsoleUrl ? { webConsoleUrl: info.webConsoleUrl } : {}),
      ...(info?.webAccessUrls?.length ? { webAccessUrls: info.webAccessUrls } : {})
    }));
    // restart 的结果 JSON 由这个 daemonized child 自己打出（父进程已被
    // daemonize 退出），凭证链接要从 ready 后的 state 里取回，不能漏。
    return { ok: true, action: 'start', running: true, pid: process.pid, webConsoleUrl: readDaemonStatus(dir)?.webConsoleUrl, webAccessUrls: readDaemonStatus(dir)?.webAccessUrls };
  }

  // Foreground parent: refuse to double-start.
  const runningDir = resolveDaemonDir(cwd);
  const current = readDaemonStatus(runningDir);
  if (current && current.pid > 0 && pidAlive(current.pid)) {
    return { ok: false, action: 'start', running: true, pid: current.pid, state: 'already-running', webConsoleUrl: current.webConsoleUrl, webAccessUrls: current.webAccessUrls, error: `AgentDock is already running (pid ${current.pid}). Use 'agent-dock status' or 'agent-dock restart'.` };
  }

  const startedAt = new Date().toISOString();
  clearState(dir);
  const spawned = daemonize({ cwd, startedAt, env });

  // 父进程保持存活：轮询 daemon 就绪，随后把本次启动日志回显给用户终端。
  return waitUntilReady(dir, spawned.logFile, spawned.startOffset);
}

/** 读取日志文件从 startOffset 起的新增内容，封顶 STARTUP_LOG_MAX_BYTES。 */
export function readStartupLog(logFile: string, startOffset: number, maxBytes = STARTUP_LOG_MAX_BYTES): string {
  let size = 0;
  try {
    size = readFileSync(logFile).length;
  } catch {
    return '';
  }
  const begin = Math.max(0, startOffset, size - maxBytes);
  const buf = readFileSync(logFile, { encoding: 'utf8' });
  return buf.slice(begin).trim();
}

async function waitUntilReady(dir: string, logFile: string, startOffset: number): Promise<DaemonCommandResult> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = readDaemonStatus(dir);
    if (state && state.pid > 0 && pidAlive(state.pid) && state.ready) {
      return { ok: true, action: 'start', running: true, pid: state.pid, address: state.address, logFile, state: 'started', webConsoleUrl: state.webConsoleUrl, webAccessUrls: state.webAccessUrls, startupLog: readStartupLog(logFile, startOffset) };
    }
    await sleep(200);
  }
  const state = readDaemonStatus(dir);
  const pid = pidFromState(state);
  const startupLog = readStartupLog(logFile, startOffset);
  if (pid > 0 && pidAlive(pid)) {
    return { ok: true, action: 'start', running: true, pid, address: state?.address, logFile, state: 'started', webConsoleUrl: state?.webConsoleUrl, webAccessUrls: state?.webAccessUrls, startupLog, error: 'Daemon started but did not report ready within the timeout.' };
  }
  return { ok: false, action: 'start', running: false, state: 'not-running', logFile, startupLog, error: 'Daemon failed to start within the timeout. See the startup log below for details.' };
}

/** `agent-dock stop`: SIGTERM the daemon and clear its state. */
export async function daemonStop(): Promise<DaemonCommandResult> {
  const dir = resolveDaemonDir();
  const state = readDaemonStatus(dir);
  const pid = pidFromState(state);

  if (!pid || !pidAlive(pid)) {
    clearState(dir);
    return { ok: true, action: 'stop', running: false, state: 'not-running' };
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    clearState(dir);
    return { ok: false, action: 'stop', running: false, state: 'stopped', error: `Failed to signal pid ${pid}.` };
  }

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) {
      clearState(dir);
      return { ok: true, action: 'stop', running: false, pid, state: 'stopped' };
    }
    await sleep(200);
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
  await sleep(200);
  clearState(dir);
  return { ok: true, action: 'stop', running: false, pid, state: 'stopped', error: 'Graceful stop timed out; sent SIGKILL.' };
}

/** `agent-dock restart`: stop, then start again. */
export async function daemonRestart(options: CliOptions, handlers: DaemonCommandHandlers, env: NodeJS.ProcessEnv = process.env): Promise<DaemonCommandResult> {
  // Resolve the currently running daemon's directory so we can restart it in
  // the same working directory (important when the user runs `restart` from a
  // different directory than where the daemon was started).
  const runningDir = resolveDaemonDir();
  const previousState = readDaemonStatus(runningDir);
  const previousCwd = previousState?.cwd;
  const restartOptions = daemonRestartOptions(options, previousState, env);
  const restartEnv = {
    ...env,
    ...(restartOptions.cwd ? { [RESTART_CWD_ENV]: restartOptions.cwd } : {}),
    ...(restartOptions.database ? { [RESTART_DATABASE_ENV]: restartOptions.database } : {}),
    ...(restartOptions.host ? { [RESTART_HOST_ENV]: restartOptions.host } : {}),
    ...(restartOptions.port ? { [RESTART_PORT_ENV]: restartOptions.port } : {})
  };
  if (previousCwd && previousCwd !== process.cwd()) {
    process.chdir(previousCwd);
  }
  await daemonStop();
  const started = await daemonStart(restartOptions, handlers, restartEnv);
  return started.running
    ? { ...started, action: 'restart' as const, state: 'restarted' as const }
    : { ok: false, action: 'restart' as const, running: false, state: 'not-running' as const, error: started.error };
}

export interface DaemonStatusInfo {
  running: boolean;
  pid?: number;
  address?: string;
  logFile?: string;
  startedAt?: string;
  ready?: boolean;
  webConsoleUrl?: string;
  webAccessUrls?: AccessUrl[];
}

/** `agent-dock status`: report whether a daemon is alive and where. */
export function daemonStatus(): DaemonStatusInfo {
  const dir = resolveDaemonDir();
  const state = readDaemonStatus(dir);
  const pid = pidFromState(state);
  const alive = pid > 0 && pidAlive(pid);
  return {
    running: alive,
    pid: alive ? pid : undefined,
    address: alive ? state?.address : undefined,
    logFile: alive ? daemonPaths(dir).logFile : undefined,
    startedAt: alive ? state?.startedAt : undefined,
    ready: alive ? state?.ready : false,
    // 凭证链接只在 daemon 存活时有意义；进程不在了 master 凭证也应随之轮换。
    webConsoleUrl: alive ? state?.webConsoleUrl : undefined,
    webAccessUrls: alive ? state?.webAccessUrls : undefined
  };
}

function addressFromCli(options: CliOptions): { host?: string; port?: number; address?: string } {
  const host = options.host ?? (options.localOnly ? '127.0.0.1' : '0.0.0.0');
  const port = Number(options.port ?? 4310);
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  return { host, port, address: `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}` };
}
