import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pidAlive, pidFromState, readDaemonStatus, readLastDaemonDir } from './daemon.js';

export interface DatabaseServerLock {
  readonly lockPath?: string;
  release(): void;
}

export interface AcquireDatabaseLockOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** 覆盖需要交叉检查 agentdock.state.json 的 daemon 目录列表（测试用）。 */
  daemonDirs?: string[];
  home?: string;
}

interface LockFileRecord {
  pid?: number;
  database?: string;
  startedAt?: string;
}

const inProcessLocks = new Map<string, number>();

function readLockPid(lockPath: string): number {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as LockFileRecord;
    return typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : 0;
  } catch {
    return 0;
  }
}

function lockConflictError(pid: number, database: string): Error {
  return new Error(
    `AgentDock 数据库已被运行中的服务进程占用（pid ${pid}，数据库：${database}）。`
    + '请勿对同一数据库重复启动服务，以免破坏在线会话状态与队列；如需本地调试请使用 agent-dock dev up。'
  );
}

/**
 * 校验并独占数据库的服务端所有权锁。
 *
 * 必须在 `runtime.initialize()` 之前获取：否则任何误触发的第二个 `agent-dock` 进程
 * （例如 shell 模板里未转义的反引号意外执行了默认 serve，或重复起服）会在 `app.listen()`
 * 撞 EADDRINUSE 之前就把在线 daemon 正在跑的任务全部标成 `interrupted (daemon_restart)`，
 * 导致在线 daemon 内存态与 SQLite 彻底裂脑、事件序号冲突并拖卡队列。
 */
export function acquireDatabaseServerLock(
  databaseUrl: string,
  options: AcquireDatabaseLockOptions = {}
): DatabaseServerLock {
  const trimmed = databaseUrl.trim();
  if (!trimmed || trimmed === ':memory:') return { release() {} };

  const resolvedDb = resolve(trimmed);
  const selfPid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? pidAlive;

  const existingInProcessPid = inProcessLocks.get(resolvedDb);
  if (existingInProcessPid !== undefined) {
    throw lockConflictError(existingInProcessPid, resolvedDb);
  }

  // 兼容正在运行的旧版 daemon（尚未写 .server.lock）：交叉检查相邻 daemon 目录和全局指针。
  const candidateDirs = options.daemonDirs ?? [
    join(dirname(resolvedDb), 'daemon'),
    ...(readLastDaemonDir(options.home) ? [readLastDaemonDir(options.home)!] : [])
  ];
  for (const dir of new Set(candidateDirs)) {
    const state = readDaemonStatus(dir);
    const ownerPid = pidFromState(state);
    if (!state?.database || !ownerPid || ownerPid === selfPid || !isAlive(ownerPid)) continue;
    if (resolve(dir, state.database) === resolvedDb) {
      throw lockConflictError(ownerPid, resolvedDb);
    }
  }

  const lockPath = `${resolvedDb}.server.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try {
        const payload = `${JSON.stringify({ pid: selfPid, database: resolvedDb, startedAt: new Date().toISOString() })}\n`;
        writeSync(fd, payload, undefined, 'utf8');
      } finally {
        closeSync(fd);
      }
      inProcessLocks.set(resolvedDb, selfPid);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', onExit);
        if (inProcessLocks.get(resolvedDb) === selfPid) inProcessLocks.delete(resolvedDb);
        if (readLockPid(lockPath) === selfPid) {
          try { rmSync(lockPath, { force: true }); } catch { /* best-effort */ }
        }
      };
      const onExit = () => release();
      process.once('exit', onExit);
      return { lockPath, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      const ownerPid = readLockPid(lockPath);
      if (ownerPid > 0 && ownerPid !== selfPid && isAlive(ownerPid)) {
        throw lockConflictError(ownerPid, resolvedDb);
      }
      // 锁文件来自已退出的旧进程或损坏残留：回收后重试一次。
      if (attempt === 0) {
        try { rmSync(lockPath, { force: true }); } catch { /* retry will surface */ }
        continue;
      }
      throw lockConflictError(ownerPid || selfPid, resolvedDb);
    }
  }
  throw lockConflictError(selfPid, resolvedDb);
}
