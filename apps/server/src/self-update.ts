import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { RuntimeError } from '@agent-dock/agent-dock-shared';
import { DAEMON_CWD_ENV, DAEMON_ENV_FLAG, DAEMON_STARTED_AT_ENV, isDaemonChild, pidAlive } from './daemon/daemon.js';
import { compareVersions, distTagForVersion, runNpmForAgentDockUpdate } from './update.js';

/** 服务进程的三种生命周期：npm daemon、Electron 桌面壳、裸前台 serve。 */
export type SelfUpdateRuntime = 'daemon' | 'desktop' | 'foreground';

export interface SelfUpdateStatus {
  currentVersion: string;
  distTag: string;
  latestVersion?: string;
  updateAvailable: boolean;
  /**
   * 只有 daemon 模式能在界面上升级：前台 serve 重启后没人把它拉起来。
   * 桌面版由 Electron 的自动更新负责，这里恒为 false。
   */
  canUpdate: boolean;
  updating: boolean;
  /** 运行形态。桌面版不能走 npm 升级，前端据此切换成桌面更新入口。 */
  runtime: SelfUpdateRuntime;
  /** 上一次界面触发的升级失败原因（安装失败时旧服务还活着，能报回来）。 */
  lastError?: string;
  checkedAt?: number;
  checkError?: string;
}

export interface SelfUpdateOptions {
  currentVersion: string;
  packageName: string;
  /** 当前安装的 CLI 入口（dist/cli.js），升级子进程用它跑 `agent-dock update`。 */
  cliEntrypoint: string;
  env?: NodeJS.ProcessEnv;
  runNpm?: (args: string[]) => Promise<string>;
  spawnUpdate?: (args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; logFile: string }) => { pid?: number; onExit(listener: (code: number | null) => void): void };
  lockFile?: string;
  now?: () => number;
}

const CHECK_TTL_MS = 30 * 60_000;
const CHECK_ERROR_TTL_MS = 2 * 60_000;

const defaultSpawnUpdate: NonNullable<SelfUpdateOptions['spawnUpdate']> = (args, options) => {
  mkdirSync(dirname(options.logFile), { recursive: true });
  const fd = openSync(options.logFile, 'w', 0o600);
  // detached：重启会杀掉当前服务进程，升级进程必须活过它才能把新版本拉起来。
  const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', fd, fd], detached: true });
  closeSync(fd);
  child.unref();
  return { ...(child.pid ? { pid: child.pid } : {}), onExit: listener => { child.once('exit', listener); child.once('error', () => listener(1)); } };
};

const tail = (file: string, lines = 6) => {
  try { return readFileSync(file, 'utf8').trim().split('\n').slice(-lines).join('\n'); } catch { return ''; }
};

/**
 * 界面上的「检查新版本 / 一键升级」。升级本身复用 `agent-dock update`（安装、校验、重启 daemon），
 * 这里只负责：缓存版本检查、在脱离的子进程里拉起它、防重复触发、把安装阶段的失败报回给界面。
 */
/** 一次升级（npm install + 重启）的上限；超过就不再信任锁里的 pid。 */
const UPDATE_LOCK_MAX_AGE_MS = 15 * 60_000;

export class SelfUpdateService {
  private cached?: { latestVersion?: string; checkError?: string; checkedAt: number };
  private checking?: Promise<void>;
  private updating = false;
  private updateStartedAt?: number;
  private lastError?: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly lockFile: string;
  private readonly now: () => number;

  constructor(private readonly options: SelfUpdateOptions) {
    this.env = options.env ?? process.env;
    this.lockFile = options.lockFile ?? join(this.env.HOME ?? homedir(), '.agentdock', 'update.lock');
    this.now = options.now ?? Date.now;
  }

  get distTag() { return distTagForVersion(this.options.currentVersion); }

  /**
   * 桌面壳把打包好的 CLI 当普通前台子进程 spawn，但它自己就是 supervisor。
   * 先判 desktop：Electron 从终端继承环境时可能带上 AGENTDOCK_DAEMONIZED，
   * 把桌面实例误认成 daemon 会放开一条完全错误（而且危险）的 npm 升级路径。
   */
  get runtime(): SelfUpdateRuntime {
    if (this.env.AGENTDOCK_DESKTOP_INSTANCE?.trim()) return 'desktop';
    return isDaemonChild(this.env) ? 'daemon' : 'foreground';
  }

  async status(refresh = false): Promise<SelfUpdateStatus> {
    const runtime = this.runtime;
    if (runtime === 'desktop') {
      // 桌面版的版本检查在 Electron 主进程里走 GitHub Releases；这里不碰 npm：
      // 打包运行时不含 npm，而且 npm 上的 CLI 版本也不是桌面安装包。
      return {
        currentVersion: this.options.currentVersion,
        distTag: this.distTag,
        updateAvailable: false,
        canUpdate: false,
        updating: false,
        runtime
      };
    }
    const age = this.cached ? this.now() - this.cached.checkedAt : Infinity;
    const ttl = this.cached?.checkError ? CHECK_ERROR_TTL_MS : CHECK_TTL_MS;
    if (refresh || age > ttl) await (this.checking ??= this.check().finally(() => { this.checking = undefined; }));
    const latestVersion = this.cached?.latestVersion;
    return {
      currentVersion: this.options.currentVersion,
      distTag: this.distTag,
      ...(latestVersion ? { latestVersion } : {}),
      updateAvailable: Boolean(latestVersion && compareVersions(latestVersion, this.options.currentVersion) > 0),
      canUpdate: runtime === 'daemon',
      updating: this.updateActive() || this.lockHeld(),
      runtime,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.cached ? { checkedAt: this.cached.checkedAt } : {}),
      ...(this.cached?.checkError ? { checkError: this.cached.checkError } : {})
    };
  }

  /** 超过升级最长时限的「进行中」标记视为过期，避免子进程卡死时页面永远转圈。 */
  private updateActive() {
    if (!this.updating) return false;
    return this.updateStartedAt !== undefined && this.now() - this.updateStartedAt < UPDATE_LOCK_MAX_AGE_MS;
  }

  private async check() {
    const runNpm = this.options.runNpm ?? runNpmForAgentDockUpdate;
    try {
      const raw = await runNpm(['view', `${this.options.packageName}@${this.distTag}`, 'version', '--json']);
      const value = JSON.parse(raw);
      if (typeof value !== 'string' || !value.trim()) throw new Error(`dist-tag ${this.distTag} 没有对应版本`);
      this.cached = { latestVersion: value.trim(), checkedAt: this.now() };
    } catch (error) {
      this.cached = { checkError: `检查新版本失败：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`, checkedAt: this.now() };
    }
  }

  /**
   * 另一个 AgentDock 实例或上一次升级的子进程还在跑时，锁文件里的 pid 仍活着。
   *
   * 只看 pid 不够：升级成功时旧 daemon 被重启杀掉，走不到 onExit 删锁；之后这个 pid 被系统进程复用，
   * 界面就永远停在「正在升级」。升级进程本身只是 npm install + restart，超过时限的锁一律当作过期。
   */
  private lockHeld() {
    try {
      if (this.now() - statSync(this.lockFile).mtimeMs > UPDATE_LOCK_MAX_AGE_MS) return false;
      return pidAlive(Number(readFileSync(this.lockFile, 'utf8').trim()));
    } catch { return false; }
  }

  private acquireLock(pid: number) {
    mkdirSync(dirname(this.lockFile), { recursive: true });
    try { writeFileSync(this.lockFile, String(pid), { flag: 'wx', mode: 0o600 }); return true; }
    catch {
      if (this.lockHeld()) return false;
      // 锁的主人已经不在了（升级子进程退出、机器重启）：当作过期锁接管。
      rmSync(this.lockFile, { force: true });
      try { writeFileSync(this.lockFile, String(pid), { flag: 'wx', mode: 0o600 }); return true; } catch { return false; }
    }
  }

  async start(): Promise<SelfUpdateStatus> {
    const runtime = this.runtime;
    if (runtime === 'desktop') throw new RuntimeError('UPDATE_DESKTOP_MANAGED', '桌面版由应用内自动更新负责，请在侧边栏的更新入口升级', 409);
    if (runtime !== 'daemon') throw new RuntimeError('UPDATE_REQUIRES_DAEMON', '当前是前台运行（agent-dock serve），界面升级后无法自动拉起新版本；请先停止前台进程，再在终端执行 npm install -g 或改用 agent-dock start', 409);
    if (!this.updateActive() && this.updating) { this.updating = false; this.updateStartedAt = undefined; }
    if (this.updateActive() || this.lockHeld()) throw new RuntimeError('UPDATE_IN_PROGRESS', '已有升级在进行，稍等片刻', 409);
    // 先占位再检查：npm view 是一个网络请求，两个并发的 POST 都能在这段时间里
    // 通过上面的判断，最后各拉起一个升级进程。
    this.updating = true;
    this.updateStartedAt = this.now();
    this.lastError = undefined;
    const cwd = this.env[DAEMON_CWD_ENV] ?? process.cwd();
    const logFile = join(cwd, '.agentdock', 'daemon', 'update.log');
    // 子进程是一个普通的 CLI 调用，不能带 daemon 标记，否则它里面的 `daemon restart` 会把自己当成 daemon 本体。
    const env = { ...this.env };
    delete env[DAEMON_ENV_FLAG]; delete env[DAEMON_CWD_ENV]; delete env[DAEMON_STARTED_AT_ENV];
    try {
      const status = await this.status(true);
      if (!status.updateAvailable) throw new RuntimeError('UPDATE_NOT_AVAILABLE', status.checkError ?? `已是最新版本（${status.currentVersion}）`, 409);
      const child = (this.options.spawnUpdate ?? defaultSpawnUpdate)([this.options.cliEntrypoint, 'update', '--dist-tag', this.distTag], { cwd, env, logFile });
      if (!child.pid) throw new Error('无法启动升级进程');
      if (!this.acquireLock(child.pid)) {
        // 另一个实例抢到了锁：它的升级进程已经在跑，这个刚 spawn 出来的必须
        // 停掉，否则两个 npm install -g 会同时写全局目录。
        try { process.kill(child.pid, 'SIGTERM'); } catch { /* 已退出 */ }
        throw new Error('另一个实例已经在升级');
      }
      const lockedPid = child.pid;
      child.onExit(code => {
        this.updating = false;
        this.updateStartedAt = undefined;
        try { if (readFileSync(this.lockFile, 'utf8').trim() === String(lockedPid)) rmSync(this.lockFile, { force: true }); } catch { /* 已被清理 */ }
        // 成功时当前进程已被重启杀掉，走不到这里；还活着说明安装或校验失败。
        if (code !== 0) this.lastError = describeUpdateFailure(tail(logFile), this.options.packageName, this.distTag);
      });
    } catch (error) {
      this.updating = false;
      this.updateStartedAt = undefined;
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('UPDATE_FAILED', error instanceof Error ? error.message : String(error), 500);
    }
    return this.status();
  }
}

/** 把 npm 的报错翻成可操作的提示；最常见的是全局目录当初用 sudo 装的，没有写权限。 */
export function describeUpdateFailure(log: string, packageName: string, distTag: string) {
  const manual = `npm install -g ${packageName}@${distTag} && agent-dock restart`;
  if (/EACCES|permission denied/i.test(log)) return `没有 npm 全局目录的写权限，请在终端手动执行：${manual}`;
  const last = log.split('\n').filter(line => line.trim()).at(-1);
  return `升级失败${last ? `：${last.slice(0, 300)}` : ''}。可在终端手动执行：${manual}`;
}

export function registerSelfUpdateRoutes(app: FastifyInstance, service: SelfUpdateService) {
  app.get<{ Querystring: { refresh?: string } }>('/api/system/update', async request => service.status(request.query.refresh === '1'));
  app.post('/api/system/update', async () => service.start());
}
